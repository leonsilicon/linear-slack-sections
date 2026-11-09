"""Simulated integration: in-process API adapters, never live accounts."""
import copy
import tempfile
import unittest
from pathlib import Path

from linear_slack_sections import core


class LinearFake:
    def __init__(self):
        self.calls = []
        self.status = 'Started'
    def entity(self, kind, identifier):
        self.calls.append((kind, identifier))
        return {'id': '11111111-1111-4111-8111-111111111111', 'status': self.status,
                'channel_id': 'CPROJECT' if kind == 'project' else None}


class SlackFake:
    def __init__(self):
        self.layout = {'SOLD': {'name': 'Old', 'channels': ['CISSUE', 'CPROJECT']},
                       'SACTIVE': {'name': 'Active', 'channels': []}}
        self.writes = []
        self.team = 'TEXAMPLE'
    def identity(self):
        return {'team_id': self.team, 'user_id': 'UOWNER'}
    def sections(self):
        return copy.deepcopy(self.layout)
    def move(self, channel, target, sources):
        self.writes.append(('move', channel, target, sources))
        for source in sources:
            self.layout[source]['channels'].remove(channel)
        self.layout[target]['channels'].append(channel)


def config():
    return {'team_id': 'TEXAMPLE', 'owner_user_id': 'UOWNER', 'max_changes': 10,
            'sections': {'Started': {'id': 'SACTIVE'}},
            'entities': [{'type': 'issue', 'id': 'DEMO-1', 'channel_id': 'CISSUE'},
                         {'type': 'project', 'id': '22222222-2222-4222-8222-222222222222',
                          'use_project_channel': True}]}


class BotFake:
    def __init__(self, path):
        self.path, self.created, self.fail_invite, self.team = path, [], True, 'TEXAMPLE'
    def identity(self):
        return {'team_id': self.team, 'user_id': 'UBOT'}
    def create_channel(self, name, private):
        self.created.append((name, private))
        return 'CCREATED'
    def invite(self, channel, user):
        assert self.path.exists(), 'created ID must be durable before invite'
        if self.fail_invite:
            raise ValueError('invite failed')
    def verify_channel(self, channel, name=None, private=None, owner=None):
        return True


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'state.json'
        self.linear, self.slack = LinearFake(), SlackFake()
    def run_sync(self, cfg=None, apply=False, **kw):
        return core.sync(cfg or config(), self.linear, self.slack, self.path, apply=apply, **kw)
    def test_apply_moves_verifies_and_persists_team_entity_status(self):
        self.run_sync(apply=True)
        self.assertEqual(len(self.slack.writes), 2)
        self.assertEqual(self.slack.layout['SOLD']['channels'], [])
        import json
        state = json.loads(self.path.read_text())
        self.assertEqual(state['teams']['TEXAMPLE']['issue:DEMO-1']['status'], 'Started')
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.run_sync(apply=True), [])
        self.slack.layout['SACTIVE']['channels'].remove('CISSUE')
        self.slack.layout['SOLD']['channels'].append('CISSUE')
        self.assertEqual(len(self.run_sync(apply=True)), 1)
        self.assertEqual(len(self.linear.calls), 6)

    def test_safety_preflight_refuses_workspace_unknown_status_brake_and_conflicts(self):
        for change, message in [
            (lambda c: c.update(team_id='TOTHER'), 'workspace'),
            (lambda c: c.update(owner_user_id='UOTHER'), 'owner'),
            (lambda c: c.update(max_changes=1), 'max_changes'),
            (lambda c: c.update(sections={'Other': {'id': 'SACTIVE'}}), 'unmapped status'),
            (lambda c: c['entities'][1].update(channel_id='CISSUE', use_project_channel=False), 'multiple'),
            (lambda c: c['entities'][0].update(id='not an identifier'), 'identifier'),
            (lambda c: c.update(api_url='http://evil'), 'unknown'),
        ]:
            with self.subTest(message=message):
                cfg = config()
                change(cfg)
                with self.assertRaisesRegex(ValueError, message):
                    self.run_sync(cfg, apply=True)
                self.assertEqual(self.slack.writes, [])
                self.assertFalse(self.path.exists())

    def test_failed_readback_does_not_record_status_success(self):
        self.slack.move = lambda *args: None
        with self.assertRaisesRegex(ValueError, 'verification'):
            self.run_sync(apply=True)
        if self.path.exists():
            self.assertNotIn('Started', self.path.read_text())

    def test_creation_is_preview_only_until_apply_and_persists_before_invite(self):
        cfg = config()
        cfg['entities'] = [{'type': 'issue', 'id': 'DEMO-2',
                            'create_channel': {'private': True, 'prefix': 'lin'}}]
        cfg['sections'] = {'Started': {'name': 'New Active', 'create': True}}
        bot = BotFake(self.path)
        self.slack.create_section = lambda name: self.slack.layout.update(
            SNEW={'name': name, 'channels': []}) or 'SNEW'
        preview = self.run_sync(cfg, bot=bot)
        self.assertEqual([r['action'] for r in preview], ['create_section', 'create_channel', 'move'])
        self.assertFalse(self.path.exists())
        self.assertEqual(bot.created, [])
        with self.assertRaisesRegex(ValueError, 'invite failed'):
            self.run_sync(cfg, apply=True, bot=bot)
        import json
        record = json.loads(self.path.read_text())['teams']['TEXAMPLE']['issue:DEMO-2']
        self.assertEqual(record['channel_id'], 'CCREATED')
        self.assertNotIn('status', record)
        bot.fail_invite = False
        self.run_sync(cfg, apply=True, bot=bot)
        self.assertEqual(len(bot.created), 1)
        self.assertEqual(bot.created[0][1], True)
        self.assertRegex(bot.created[0][0], r'^lin-issue-[a-f0-9]{16}$')
        self.assertIn('CCREATED', self.slack.layout['SNEW']['channels'])
        self.assertEqual(self.run_sync(cfg, apply=True, bot=bot), [])

    def test_completed_creation_does_not_override_current_project_binding(self):
        cfg = config()
        project = cfg['entities'][1]
        project.pop('use_project_channel')
        project['create_channel'] = {'private': True}
        cfg['entities'] = [project]
        bot = BotFake(self.path)
        bot.fail_invite = False
        self.run_sync(cfg, apply=True, bot=bot)
        self.slack.writes.clear()

        project.pop('create_channel')
        project['use_project_channel'] = True
        plan = self.run_sync(cfg, apply=True)

        self.assertEqual([item['channel_id'] for item in plan], ['CPROJECT'])
        self.assertEqual(self.slack.writes, [('move', 'CPROJECT', 'SACTIVE', ['SOLD'])])
        self.assertIn('CCREATED', self.slack.layout['SACTIVE']['channels'])
        self.assertIn('CPROJECT', self.slack.layout['SACTIVE']['channels'])

    def test_unfinished_creation_refuses_project_mode_switch_without_writes(self):
        import json
        cfg = config()
        cfg['entities'] = [cfg['entities'][1]]
        key = 'project:' + cfg['entities'][0]['id']
        bot = BotFake(self.path)
        bot.fail_invite = False
        bot_writes = []
        bot.invite = lambda *args: bot_writes.append(args)
        original_entity = self.linear.entity
        for project_channel in ('CPROJECT', 'CCREATED'):
            with self.subTest(project_channel=project_channel):
                self.linear.entity = lambda *args: dict(original_entity(*args), channel_id=project_channel)
                original_state = json.dumps({'teams': {'TEXAMPLE': {key: {
                    'channel_id': 'CCREATED', 'channel_name': 'old', 'private': True}}}})
                self.path.write_text(original_state)
                with self.assertRaisesRegex(ValueError, 'unfinished'):
                    self.run_sync(cfg, apply=True, bot=bot)
                self.assertEqual(self.slack.writes, [])
                self.assertEqual(bot.created, [])
                self.assertEqual(bot_writes, [])
                self.assertEqual(self.path.read_text(), original_state)

    def test_canonical_issue_aliases_refuse_all_writes_before_apply(self):
        canonical_id = '11111111-1111-4111-8111-111111111111'
        for mode in ('explicit', 'create'):
            for apply in (False, True):
                with self.subTest(mode=mode, apply=apply):
                    self.slack = SlackFake()
                    cfg = config()
                    cfg['sections'] = {'Started': {'name': 'New Active', 'create': True}}
                    cfg['entities'] = [
                        {'type': 'issue', 'id': 'DEMO-1'},
                        {'type': 'issue', 'id': canonical_id},
                    ]
                    for index, binding in enumerate(cfg['entities']):
                        if mode == 'explicit':
                            binding['channel_id'] = ('CISSUE', 'COTHER')[index]
                        else:
                            binding['create_channel'] = {'private': True,
                                                         'prefix': ('one', 'two')[index]}
                    def create_section(name):
                        self.slack.writes.append(('create_section', name))
                        self.slack.layout['SNEW'] = {'name': name, 'channels': []}
                        return 'SNEW'
                    self.slack.create_section = create_section
                    bot = BotFake(self.path)
                    bot.fail_invite = False
                    bot_writes = []
                    bot.invite = lambda *args: bot_writes.append(args)
                    with self.assertRaisesRegex(ValueError, 'multiple bindings for entity'):
                        self.run_sync(cfg, apply=apply, bot=bot)
                    self.assertEqual(self.slack.writes, [])
                    self.assertEqual(bot.created, [])
                    self.assertEqual(bot_writes, [])
                    self.assertFalse(self.path.exists())
                    self.assertEqual(list(self.path.parent.iterdir()), [])

    def test_creation_requires_matching_bot_workspace_before_any_write(self):
        cfg = config()
        bot = BotFake(self.path)
        bot.team = 'TWRONG'
        with self.assertRaisesRegex(ValueError, 'workspace'):
            self.run_sync(cfg, apply=True, bot=bot)
        self.assertEqual(self.slack.writes, [])

    def test_creation_and_binding_options_are_strictly_validated(self):
        for update in [
            {'create_channel': {'prefix': 'lin'}},
            {'create_channel': {'private': 'false'}},
            {'create_channel': {'private': True, 'prefix': 'Bad Prefix'}},
            {'create_channel': {'private': True}, 'channel_id': 'CEXPLICIT'},
            {'use_project_channel': True},
            {'channel_id': 'invalid channel'},
        ]:
            cfg = config()
            cfg['entities'] = [dict(type='issue', id='DEMO-1', **update)]
            with self.subTest(update=update), self.assertRaises(ValueError):
                self.run_sync(cfg)

    def test_apply_lock_prevents_concurrent_worker_and_preview_stays_read_only(self):
        self.assertTrue(hasattr(core, 'StateLock'), 'state locking missing')
        with core.StateLock(self.path):
            with self.assertRaisesRegex(ValueError, 'locked'):
                self.run_sync(apply=True)
            self.assertEqual(len(self.run_sync()), 2)
        self.run_sync(apply=True)

    def test_corrupt_state_refuses_all_writes(self):
        self.path.write_text('{broken')
        with self.assertRaisesRegex(ValueError, 'state'):
            self.run_sync(apply=True)
        self.assertEqual(self.slack.writes, [])

    def test_section_and_state_shapes_fail_closed(self):
        for mapping in [{'id': ['bad']}, {'name': ''}, {'name': 'x', 'create': 'false'},
                        {'id': 'S1', 'name': 'both'}, {'name': 42}]:
            cfg = config()
            cfg['sections'] = {'Started': mapping}
            with self.subTest(mapping=mapping), self.assertRaises(ValueError):
                core.validate(cfg)
        for state in [{'teams': []}, {'teams': {'TEXAMPLE': []}},
                      {'teams': {'TEXAMPLE': {'issue:DEMO-1': {'channel_id': 'bad'}}}}]:
            import json
            self.path.write_text(json.dumps(state))
            with self.subTest(state=state), self.assertRaisesRegex(ValueError, 'state'):
                self.run_sync(apply=True)
        self.assertEqual(self.slack.writes, [])

    def test_each_poll_uses_new_status_including_issue_uuid(self):
        cfg = config()
        cfg['entities'][0]['id'] = '33333333-3333-4333-8333-333333333333'
        cfg['sections']['Done'] = {'id': 'SOLD'}
        self.run_sync(cfg, apply=True)
        self.linear.status = 'Done'
        result = self.run_sync(cfg, apply=True)
        self.assertEqual(len(result), 2)
        self.assertEqual(self.slack.layout['SACTIVE']['channels'], [])
        self.assertEqual(set(self.slack.layout['SOLD']['channels']), {'CISSUE', 'CPROJECT'})
        import json
        self.assertEqual(json.loads(self.path.read_text())['teams']['TEXAMPLE'][
            'issue:33333333-3333-4333-8333-333333333333']['status'], 'Done')

    def test_unfinished_created_channel_retry_requires_bot_even_after_rebinding(self):
        import json
        self.path.write_text(json.dumps({'teams': {'TEXAMPLE': {'issue:DEMO-1': {
            'channel_id': 'CCREATED', 'channel_name': 'n', 'private': True}}}}))
        with self.assertRaisesRegex(ValueError, 'bot'):
            self.run_sync(apply=True)
        self.assertEqual(self.slack.writes, [])

    def test_preview_reads_explicit_issues_and_projects_without_writes(self):
        self.assertTrue(callable(getattr(core, 'sync', None)), 'sync feature missing')
        result = self.run_sync()
        self.assertEqual([r['action'] for r in result], ['move', 'move'])
        self.assertEqual(self.linear.calls, [('issue', 'DEMO-1'), ('project', config()['entities'][1]['id'])])
        self.assertEqual(self.slack.writes, [])
        self.assertFalse(self.path.exists())
        self.assertEqual(list(self.path.parent.iterdir()), [])
