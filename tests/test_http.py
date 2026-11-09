import json
import unittest
from urllib.error import HTTPError, URLError
from unittest.mock import patch
from linear_slack_sections import api


class Response:
    def __init__(self, value):
        self.value = value
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def read(self, *args):
        return json.dumps(self.value).encode()


class HttpTests(unittest.TestCase):
    def test_rate_limit_honors_retry_after_and_timeout(self):
        self.assertTrue(hasattr(api, 'Http'), 'HTTP transport missing')
        sleeps, requests = [], []
        def opener(request, timeout):
            requests.append((request, timeout))
            if len(requests) == 1:
                raise HTTPError(request.full_url, 429, 'sensitive', {'Retry-After': '3'}, None)
            return Response({'ok': True})
        result = api.Http(opener=opener, sleep=sleeps.append).request(
            'https://slack.com/api/auth.test', b'', {})
        self.assertEqual(result, {'ok': True})
        self.assertEqual(sleeps, [3])
        self.assertEqual(requests[0][1], 20)

    def test_retries_bounded_and_creation_never_replayed_after_ambiguous_network_error(self):
        self.assertTrue(hasattr(api, 'Http'), 'HTTP transport missing')
        for url, expected in [('https://api.linear.app/graphql', 4),
                              ('https://slack.com/api/conversations.create', 1),
                              ('https://slack.com/api/users.channelSections.create', 1)]:
            count = []
            def opener(*args, **kwargs):
                count.append(1)
                raise URLError('SECRET')
            with self.assertRaises(ValueError) as caught:
                api.Http(opener=opener, sleep=lambda _: None).request(url, b'', {})
            self.assertEqual(len(count), expected)
            self.assertNotIn('SECRET', str(caught.exception))

    def test_disallows_arbitrary_hosts_and_redirects(self):
        self.assertTrue(hasattr(api, 'Http'), 'HTTP transport missing')
        with self.assertRaisesRegex(ValueError, 'destination'):
            api.Http().request('https://evil.invalid', b'', {})
        def opener(request, timeout):
            raise HTTPError(request.full_url, 302, 'SECRET', {'Location': 'https://evil.invalid'}, None)
        with self.assertRaisesRegex(ValueError, 'HTTP 302'):
            api.Http(opener=opener).request('https://slack.com/api/auth.test', b'', {})

    def test_create_collision_is_not_adopted_and_invite_is_verified_paginated(self):
        self.assertTrue(hasattr(api.Slack, 'create_channel'), 'creation adapter missing')
        from test_api import Transport
        t = Transport([{'ok': False, 'error': 'name_taken'}])
        with self.assertRaisesRegex(ValueError, 'collision'):
            api.Slack('bot', None, t).create_channel('linear-issue-name', True)
        self.assertEqual(len(t.calls), 1)
        t = Transport([{'ok': True, 'channel': {'id': 'C1'}},
                       {'ok': True},
                       {'ok': True, 'channel': {'id': 'C1', 'name': 'n', 'is_private': True}},
                       {'ok': True, 'members': ['UBOT'], 'response_metadata': {'next_cursor': 'next'}},
                       {'ok': True, 'members': ['UOWNER'], 'response_metadata': {'next_cursor': ''}}])
        slack = api.Slack('bot', None, t)
        self.assertEqual(slack.create_channel('n', True), 'C1')
        slack.invite('C1', 'UOWNER')
        slack.verify_channel('C1', 'n', True, 'UOWNER')
        from urllib.parse import parse_qs
        self.assertEqual(parse_qs(t.calls[0][1].decode())['is_private'], ['true'])
        self.assertNotIn('Cookie', t.calls[0][2])
        self.assertEqual(parse_qs(t.calls[-1][1].decode())['cursor'], ['next'])

    def test_creation_requires_valid_readback_and_id_shapes(self):
        for method, response in [('create_channel', {'ok': True, 'channel': None}),
                                 ('create_section', {'ok': True, 'channel_section': None})]:
            from test_api import Transport
            with self.subTest(method=method), self.assertRaises(ValueError):
                slack = api.Slack('bot', None, Transport([response]))
                if method == 'create_channel':
                    slack.create_channel('n', True)
                else:
                    slack.create_section('n')
        from test_api import Transport
        with self.assertRaises(ValueError):
            api.Slack('bot', None, Transport([{'ok': True, 'channel': None}])).verify_channel('C1')
        with self.assertRaises(ValueError):
            api.Linear('t', Transport([{'data': {'issue': {'state': {'name': 'Done'}}}}])).entity('issue', 'DEMO-1')

    def test_section_create_returns_id_and_missing_owner_fails(self):
        self.assertTrue(hasattr(api.Slack, 'create_section'), 'section creation missing')
        from test_api import Transport
        t = Transport([{'ok': True, 'channel_section': {'channel_section_id': 'S1'}}])
        self.assertEqual(api.Slack('xoxc-t', 'd', t).create_section('n'), 'S1')
        t = Transport([{'ok': True, 'channel': {'id': 'C1'}}, {'ok': True, 'members': []}])
        with self.assertRaisesRegex(ValueError, 'owner'):
            api.Slack('bot', None, t).verify_channel('C1', owner='UOWNER')
