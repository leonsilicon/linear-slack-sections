"""Fixed-host API adapters. Remote response text is never placed in errors."""
import json
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.parse import urlencode


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Http:
    def __init__(self, *, opener=None, sleep=time.sleep):
        self.opener = opener or build_opener(NoRedirect).open
        self.sleep = sleep

    def request(self, url, body, headers):
        if not (url == 'https://api.linear.app/graphql' or
                url.startswith('https://slack.com/api/') and
                all(c.isalnum() or c == '.' for c in url.removeprefix('https://slack.com/api/'))):
            raise ValueError('HTTP destination not allowed')
        creating = url.endswith('/conversations.create') or url.endswith('/users.channelSections.create')
        for attempt in range(4):
            delay = min(2 ** attempt, 8)
            try:
                with self.opener(Request(url, data=body, headers=headers, method='POST'), timeout=20) as response:
                    raw = response.read(8 * 1024 * 1024 + 1)
                if len(raw) > 8 * 1024 * 1024:
                    raise ValueError('API response too large')
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise ValueError('invalid API response')
                return result
            except HTTPError as exc:
                code = exc.code
                exc.close()
                retry = code == 429 or code in (500, 502, 503, 504) and not creating
                if code == 429:
                    try:
                        delay = max(0, float(exc.headers.get('Retry-After', '1')))
                    except (TypeError, ValueError):
                        delay = 1
                    if not 0 <= delay <= 120:
                        raise ValueError('rate limit wait exceeds 120 seconds; retry later') from None
                if not retry or attempt == 3:
                    raise ValueError('API HTTP ' + str(code) + '; no response body logged') from None
            except (URLError, TimeoutError, socket.timeout, ConnectionError, OSError):
                if creating or attempt == 3:
                    raise ValueError('network failure; creation may have succeeded: inspect before retry' if creating
                                     else 'network failure after bounded retries') from None
            except (UnicodeError, json.JSONDecodeError):
                raise ValueError('invalid API JSON response') from None
            self.sleep(delay)


class Linear:
    def __init__(self, token, transport):
        self.token, self.transport = token, transport

    def entity(self, kind, identifier):
        if kind not in ('issue', 'project'):
            raise ValueError('invalid entity type')
        fields = 'state { name }' if kind == 'issue' else 'status { name } slackChannelId'
        query = 'query($id: String!) { ' + kind + '(id: $id) { id ' + fields + ' } }'
        response = self.transport.request('https://api.linear.app/graphql',
            json.dumps({'query': query, 'variables': {'id': identifier}}).encode(),
            {'Authorization': self.token, 'Content-Type': 'application/json'})
        data = response.get('data')
        entity = data.get(kind) if isinstance(data, dict) else None
        if response.get('errors') or not isinstance(entity, dict):
            raise ValueError('Linear lookup failed (check access and entity ID)')
        status = entity.get('state' if kind == 'issue' else 'status')
        if not isinstance(entity.get('id'), str) or not isinstance(status, dict) or not isinstance(status.get('name'), str):
            raise ValueError('Linear status missing')
        return {'id': entity['id'], 'status': status['name'], 'channel_id': entity.get('slackChannelId')}


def incomplete(value):
    if isinstance(value, dict):
        if value.get('cursor') or value.get('next_cursor') or value.get('has_more') or value.get('has_next_page') or value.get('hasNextPage'):
            return True
        return any(incomplete(v) for v in value.values())
    if isinstance(value, list):
        return any(incomplete(v) for v in value)
    return False


class Slack:
    def __init__(self, token, cookie, transport):
        self.token, self.cookie, self.transport = token, cookie, transport

    def call(self, method, **fields):
        headers = {'Authorization': 'Bearer ' + self.token,
                   'Content-Type': 'application/x-www-form-urlencoded'}
        if self.cookie:
            headers['Cookie'] = 'd=' + self.cookie
        result = self.transport.request('https://slack.com/api/' + method,
                                        urlencode(fields).encode(), headers)
        if result.get('ok') is not True:
            if method == 'conversations.create' and result.get('error') == 'name_taken':
                raise ValueError('channel name collision; refusing to adopt existing channel')
            if method == 'conversations.invite' and result.get('error') == 'already_in_channel':
                return result
            raise ValueError('Slack API operation failed: ' + method)
        return result

    def identity(self):
        result = self.call('auth.test')
        if not result.get('team_id') or not result.get('user_id'):
            raise ValueError('Slack identity incomplete')
        return result

    def sections(self):
        result = self.call('users.channelSections.list')
        if incomplete(result) or not isinstance(result.get('channel_sections'), list):
            raise ValueError('incomplete section listing; refusing writes')
        sections = {}
        for section in result['channel_sections']:
            if not isinstance(section, dict):
                raise ValueError('incomplete or invalid section record')
            page = section.get('channel_ids_page')
            if not isinstance(page, dict) or not isinstance(page.get('channel_ids'), list):
                raise ValueError('incomplete section membership')
            channels = page['channel_ids']
            if (any(page.get(k, len(channels)) != len(channels) for k in ('total_count', 'total')) or
                    any(section.get(k, len(channels)) != len(channels) for k in ('channel_count', 'total_count'))):
                raise ValueError('incomplete section membership count')
            sid = section.get('channel_section_id')
            if not isinstance(sid, str) or not sid or sid in sections or any(not isinstance(c, str) for c in channels):
                raise ValueError('incomplete or invalid section membership')
            sections[sid] = {'name': section.get('name', ''), 'channels': channels}
        return sections

    def create_section(self, name):
        result = self.call('users.channelSections.create', name=name, emoji='')
        section = result.get('channel_section')
        sid = section.get('channel_section_id') if isinstance(section, dict) else result.get('channel_section_id')
        if not isinstance(sid, str) or not sid:
            raise ValueError('section creation returned no ID; inspect before retry')
        return sid

    def create_channel(self, name, private):
        result = self.call('conversations.create', name=name, is_private='true' if private else 'false')
        actual = result.get('channel')
        channel = actual.get('id') if isinstance(actual, dict) else None
        if not isinstance(channel, str) or not channel:
            raise ValueError('channel creation returned no ID; inspect before retry')
        return channel

    def invite(self, channel, user):
        self.call('conversations.invite', channel=channel, users=user)

    def verify_channel(self, channel, name=None, private=None, owner=None):
        actual = self.call('conversations.info', channel=channel).get('channel', {})
        if not isinstance(actual, dict) or actual.get('id') != channel or (name is not None and actual.get('name') != name) or (
                private is not None and actual.get('is_private') is not private):
            raise ValueError('channel creation verification failed')
        if owner:
            cursor, seen = '', set()
            for _ in range(1000):
                page = self.call('conversations.members', channel=channel, cursor=cursor, limit=200)
                if not isinstance(page.get('members'), list):
                    raise ValueError('owner membership verification incomplete')
                if owner in page['members']:
                    return
                cursor = page.get('response_metadata', {}).get('next_cursor', '')
                if not cursor:
                    raise ValueError('owner membership verification failed')
                if cursor in seen:
                    raise ValueError('owner membership pagination loop')
                seen.add(cursor)
            raise ValueError('owner membership pagination limit exceeded')

    def move(self, channel, target, sources):
        def item(section):
            return {'channel_section_id': section, 'channel_ids': [channel]}
        self.call('users.channelSections.channels.bulkUpdate',
                  insert=json.dumps([item(target)]), remove=json.dumps([item(s) for s in sources]))
