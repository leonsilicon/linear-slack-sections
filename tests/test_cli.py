"""CLI simulated end-to-end tests: injected API transport, real files/output."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from linear_slack_sections import cli
from test_sync import config


class ServiceTransport:
    def __init__(self):
        self.calls, self.moved = [], False
    def request(self, url, body, headers):
        self.calls.append(url)
        if url.endswith('/graphql'):
            kind = 'issue' if 'issue(' in json.loads(body)['query'] else 'project'
            return {'data': {kind: {'id': 'uuid', 'state': {'name': 'Started'},
                                    'status': {'name': 'Started'}, 'slackChannelId': 'CPROJECT'}}}
        if url.endswith('/auth.test'):
            return {'ok': True, 'team_id': 'TEXAMPLE', 'user_id': 'UOWNER'}
        if url.endswith('/users.channelSections.list'):
            return {'ok': True, 'channel_sections': [
                {'channel_section_id': 'SOLD', 'name': 'Old', 'channel_ids_page': {
                    'channel_ids': [] if self.moved else ['CISSUE', 'CPROJECT']}},
                {'channel_section_id': 'SACTIVE', 'name': 'Active', 'channel_ids_page': {
                    'channel_ids': ['CISSUE', 'CPROJECT'] if self.moved else []}}]}
        if url.endswith('/users.channelSections.channels.bulkUpdate'):
            self.moved = True
            return {'ok': True}
        raise AssertionError(url)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cfg = self.root / 'config.json'
        self.cfg.write_text(json.dumps(config()))
        self.state = self.root / 'state.json'
        self.env = {'LINEAR_API_KEY': 'fake-linear', 'SLACK_XOXC_TOKEN': 'xoxc-fake', 'SLACK_D_COOKIE': 'fake-cookie'}
        self.args = ['--config', str(self.cfg), '--state', str(self.state)]
    def invoke(self, args=None, env=None, **kw):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(self.args + (args or []), env=self.env if env is None else env, **kw)
        return code, out.getvalue(), err.getvalue()
    def test_cli_preview_then_apply_with_real_adapters(self):
        self.assertTrue(hasattr(cli, 'main'), 'CLI missing')
        t = ServiceTransport()
        code, out, err = self.invoke(transport=t)
        self.assertEqual((code, err), (0, ''))
        self.assertEqual(json.loads(out)['mode'], 'preview')
        self.assertFalse(self.state.exists())
        self.assertFalse(any('bulkUpdate' in c for c in t.calls))
        code, out, err = self.invoke(['--apply'], transport=t)
        self.assertEqual((code, err), (0, ''))
        self.assertEqual(json.loads(out)['mode'], 'apply')
        self.assertTrue(self.state.exists())
        self.assertNotIn('fake-', self.state.read_text())
    def test_missing_credentials_is_clean_error_without_network_or_values(self):
        self.assertTrue(hasattr(cli, 'main'), 'CLI missing')
        code, out, err = self.invoke(env={'LINEAR_API_KEY': 'SECRET'}, transport=ServiceTransport())
        self.assertEqual(code, 1)
        self.assertIn('SLACK_XOXC_TOKEN', err)
        self.assertNotIn('SECRET', err)
    def test_watch_repeated_preview_refetches_without_writes(self):
        self.assertTrue(hasattr(cli, 'main'), 'CLI missing')
        t, sleeps = ServiceTransport(), []
        def sleep(seconds):
            sleeps.append(seconds)
            if len(sleeps) == 2:
                raise KeyboardInterrupt
        code, out, err = self.invoke(['--watch', '--interval', '30'], transport=t, sleep=sleep)
        self.assertEqual(code, 0)
        self.assertEqual(len(out.splitlines()), 2)
        self.assertEqual(sum(c.endswith('/graphql') for c in t.calls), 4)
        self.assertFalse(self.state.exists())
    def test_watch_stops_on_error_instead_of_replaying_ambiguous_creation(self):
        self.assertTrue(hasattr(cli, 'main'), 'CLI missing')
        class Broken:
            def request(self, *args):
                raise ValueError('network failure; inspect before retry')
        code, out, err = self.invoke(['--watch', '--apply'], transport=Broken(),
                                     sleep=lambda _: self.fail('must not poll after error'))
        self.assertEqual(code, 1)
        self.assertIn('network failure', err)
    def test_bad_config_and_credential_headers_are_rejected(self):
        self.assertTrue(hasattr(cli, 'main'), 'CLI missing')
        env = dict(self.env, SLACK_D_COOKIE='d=bad; other=cookie')
        code, out, err = self.invoke(env=env, transport=ServiceTransport())
        self.assertEqual(code, 1)
        self.assertNotIn('other=cookie', err)
        self.cfg.write_text('{"secret":"SECRET"')
        code, out, err = self.invoke(transport=ServiceTransport())
        self.assertEqual(code, 1)
        self.assertNotIn('SECRET', err)
