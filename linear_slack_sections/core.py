"""Conservative desired-state synchronization. No workspace-wide discovery."""
import json
import os
import re
import tempfile
import uuid
from pathlib import Path


def validate(config):
    if not isinstance(config, dict) or set(config) - {
            'team_id', 'owner_user_id', 'max_changes', 'sections', 'entities'}:
        raise ValueError('unknown configuration fields')
    for key, prefix in [('team_id', 'T'), ('owner_user_id', 'U')]:
        if not re.fullmatch(prefix + r'[A-Z0-9]+', str(config.get(key, ''))):
            raise ValueError('invalid ' + key)
    if type(config.get('max_changes')) is not int or config['max_changes'] < 1:
        raise ValueError('max_changes must be a positive integer')
    if not isinstance(config.get('sections'), dict) or not config['sections']:
        raise ValueError('sections must be a nonempty object')
    for status, section in config['sections'].items():
        if not isinstance(status, str) or not status or not isinstance(section, dict):
            raise ValueError('invalid section mapping')
        if set(section) - {'id', 'name', 'create'}:
            raise ValueError('unknown section fields')
        if bool(section.get('id')) == bool(section.get('name')):
            raise ValueError('section requires exactly one id or name')
        if 'id' in section and (not isinstance(section['id'], str) or not section['id'] or
                                not re.fullmatch(r'[A-Za-z0-9_-]+', section['id'])):
            raise ValueError('invalid section ID')
        if 'name' in section and (not isinstance(section['name'], str) or not section['name'].strip() or
                                  len(section['name']) > 80 or any(ord(c) < 32 for c in section['name'])):
            raise ValueError('invalid section name')
        if 'create' in section and type(section['create']) is not bool:
            raise ValueError('section create must be boolean')
        if section.get('id') and section.get('create'):
            raise ValueError('cannot create section with explicit ID')
    if not isinstance(config.get('entities'), list) or not config['entities']:
        raise ValueError('entities must be a nonempty explicit list')
    seen = set()
    for binding in config['entities']:
        if not isinstance(binding, dict) or set(binding) - {
                'type', 'id', 'channel_id', 'use_project_channel', 'create_channel'}:
            raise ValueError('unknown entity fields')
        kind, identifier = binding.get('type'), binding.get('id')
        if kind not in ('issue', 'project') or not isinstance(identifier, str):
            raise ValueError('invalid entity identifier')
        try:
            valid_uuid = str(uuid.UUID(identifier)) == identifier
        except ValueError:
            valid_uuid = False
        if not valid_uuid and not (kind == 'issue' and re.fullmatch(r'[A-Z][A-Z0-9]*-[1-9][0-9]*', identifier)):
            raise ValueError('invalid entity identifier')
        key = kind + ':' + identifier
        if key in seen:
            raise ValueError('multiple bindings for entity')
        seen.add(key)
        modes = sum(bool(binding.get(k)) for k in ('channel_id', 'use_project_channel', 'create_channel'))
        if modes != 1:
            raise ValueError('exactly one channel binding mode required')
        if 'channel_id' in binding and not re.fullmatch(r'[CG][A-Z0-9]+', str(binding['channel_id'])):
            raise ValueError('invalid channel ID')
        if 'use_project_channel' in binding and (type(binding['use_project_channel']) is not bool or
                                                binding['use_project_channel'] and kind != 'project'):
            raise ValueError('project channel lookup requires project entity')
        if 'create_channel' in binding:
            options = binding['create_channel']
            if not isinstance(options, dict) or set(options) - {'private', 'prefix'} or type(options.get('private')) is not bool:
                raise ValueError('create_channel requires explicit private boolean')
            if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,35}', str(options.get('prefix', 'linear'))):
                raise ValueError('invalid channel prefix')


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.state-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(state, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class StateLock:
    """Local process lock. A crash leaves a lock: inspect before removing it."""
    def __init__(self, state_path):
        self.path = Path(str(state_path) + '.lock')

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            raise ValueError('state locked by another worker; inspect stale lock manually') from None
        with os.fdopen(fd, 'w') as stream:
            stream.write(str(os.getpid()))
        return self

    def __exit__(self, *args):
        self.path.unlink()


def sync(config, linear, slack, state_path, *, apply=False, bot=None):
    if apply:
        with StateLock(state_path):
            return _sync(config, linear, slack, state_path, apply=True, bot=bot)
    return _sync(config, linear, slack, state_path, apply=False, bot=bot)


def _sync(config, linear, slack, state_path, *, apply=False, bot=None):
    validate(config)
    identity = slack.identity()
    if identity['team_id'] != config['team_id']:
        raise ValueError('Slack workspace mismatch')
    if identity['user_id'] != config['owner_user_id']:
        raise ValueError('Slack owner mismatch')
    if bot and bot.identity()['team_id'] != config['team_id']:
        raise ValueError('bot workspace mismatch')
    path = Path(state_path)
    try:
        state = json.loads(path.read_text()) if path.exists() else {'teams': {}}
        if not isinstance(state, dict) or set(state) != {'teams'} or not isinstance(state['teams'], dict):
            raise ValueError
        for saved_team in state['teams'].values():
            if not isinstance(saved_team, dict) or any(not isinstance(r, dict) for r in saved_team.values()):
                raise ValueError
            for record in saved_team.values():
                if 'channel_id' in record and (
                        not isinstance(record['channel_id'], str) or
                        not re.fullmatch(r'[CG][A-Z0-9]+', record['channel_id']) or
                        not isinstance(record.get('channel_name'), str) or
                        type(record.get('private')) is not bool):
                    raise ValueError
    except (ValueError, UnicodeError):
        raise ValueError('invalid state file; restore a trusted backup') from None
    team = state['teams'].setdefault(config['team_id'], {})
    sections = slack.sections()
    plan, observed, channels, targets = [], [], set(), {}
    for status, mapping in config['sections'].items():
        target = mapping.get('id')
        if not target:
            matches = [sid for sid, s in sections.items() if s['name'] == mapping['name']]
            if len(matches) > 1:
                raise ValueError('ambiguous section name')
            target = matches[0] if matches else None
        if target and target in sections:
            targets[status] = target
        elif mapping.get('create') is True and not mapping.get('id'):
            target = 'pending-section:' + mapping['name']
            targets[status] = target
            if not any(p.get('target') == target for p in plan):
                plan.append({'action': 'create_section', 'name': mapping['name'], 'target': target})
        else:
            raise ValueError('destination section missing')
    canonical_entities = set()
    for binding in config['entities']:
        entity = linear.entity(binding['type'], binding['id'])
        canonical_key = (binding['type'], entity['id'])
        if canonical_key in canonical_entities:
            raise ValueError('multiple bindings for entity')
        canonical_entities.add(canonical_key)
        observed.append((binding, entity))
        key = binding['type'] + ':' + binding['id']
        record = team.get(key, {})
        channel = binding.get('channel_id')
        if binding.get('use_project_channel'):
            channel = entity.get('channel_id')
        elif binding.get('create_channel'):
            channel = record.get('channel_id')
        if not channel and binding.get('create_channel'):
            import hashlib
            options = binding['create_channel']
            name = options.get('prefix', 'linear') + '-' + binding['type'] + '-' + hashlib.sha256(
                (config['team_id'] + ':' + binding['type'] + ':' + entity['id']).encode()).hexdigest()[:16]
            channel = 'pending-channel:' + key
            plan.append({'action': 'create_channel', 'channel_id': channel, 'name': name,
                         'private': options['private'], 'key': key})
        if not channel:
            raise ValueError('entity has no channel binding')
        if binding.get('create_channel') and not bot:
            raise ValueError('bot token required for channel creation or retry')
        if record.get('channel_id') and not record.get('owner_invited'):
            if not bot:
                raise ValueError('bot token required for unfinished channel invitation')
            if not binding.get('create_channel') or channel != record['channel_id']:
                raise ValueError('unfinished created channel conflicts with binding mode; recover state first')
            plan.append({'action': 'invite_owner', 'channel_id': channel, 'key': key})
        if channel in channels:
            raise ValueError('multiple entities target one channel')
        channels.add(channel)
        mapping = config['sections'].get(entity['status'])
        if mapping is None:
            raise ValueError('unmapped status for ' + binding['type'] + ':' + binding['id'])
        target = targets[entity['status']]
        sources = [sid for sid, section in sections.items()
                   if channel in section['channels'] and sid != target]
        if channel not in sections.get(target, {'channels': []})['channels'] or sources:
            plan.append({'action': 'move', 'channel_id': channel, 'target': target,
                         'sources': sources})
    if len(plan) > config['max_changes']:
        raise ValueError('max_changes safety brake exceeded')
    if apply:
        resolved = {}
        for item in plan:
            if item['action'] == 'create_section':
                sid = slack.create_section(item['name'])
                actual = slack.sections()
                if actual.get(sid, {}).get('name') != item['name']:
                    raise ValueError('section creation verification failed')
                resolved[item['target']] = sid
                continue
            if item['action'] == 'create_channel':
                channel = bot.create_channel(item['name'], item['private'])
                record = team.setdefault(item['key'], {})
                record.update(channel_id=channel, channel_name=item['name'], private=item['private'])
                save_state(path, state)
                resolved[item['channel_id']] = channel
                bot.verify_channel(channel, item['name'], item['private'])
                bot.invite(channel, config['owner_user_id'])
                bot.verify_channel(channel, owner=config['owner_user_id'])
                record['owner_invited'] = True
                save_state(path, state)
                continue
            if item['action'] == 'invite_owner':
                record = team[item['key']]
                bot.verify_channel(item['channel_id'], record['channel_name'], record['private'])
                bot.invite(item['channel_id'], config['owner_user_id'])
                bot.verify_channel(item['channel_id'], owner=config['owner_user_id'])
                record['owner_invited'] = True
                save_state(path, state)
                continue
            channel = resolved.get(item['channel_id'], item['channel_id'])
            target = resolved.get(item['target'], item['target'])
            slack.move(channel, target, item['sources'])
            actual = slack.sections()
            if (channel not in actual.get(target, {'channels': []})['channels'] or
                    any(channel in section['channels'] for sid, section in actual.items() if sid != target)):
                raise ValueError('membership verification failed')
        for binding, entity in observed:
            team.setdefault(binding['type'] + ':' + binding['id'], {})['status'] = entity['status']
        save_state(path, state)
    return plan
