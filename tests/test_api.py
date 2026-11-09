"""Simulated transport contract tests; no external requests."""
import json
import unittest
from urllib.parse import parse_qs
from linear_slack_sections import api


class Transport:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []
    def request(self, url, body, headers):
        self.calls.append((url, body, headers))
        return self.replies.pop(0)


class ApiTests(unittest.TestCase):
    def test_linear_reads_official_explicit_status_fields(self):
        self.assertTrue(hasattr(api, 'Linear'), 'Linear adapter missing')
        t = Transport([{'data': {'issue': {'id': 'id', 'state': {'name': 'Done'}}}},
                       {'data': {'project': {'id': 'p', 'status': {'name': 'Active'}, 'slackChannelId': 'CP'}}}])
        client = api.Linear('secret', t)
        self.assertEqual(client.entity('issue', 'DEMO-1')['status'], 'Done')
        self.assertEqual(client.entity('project', 'p')['channel_id'], 'CP')
        self.assertEqual(t.calls[0][0], 'https://api.linear.app/graphql')
        self.assertEqual(json.loads(t.calls[0][1])['variables'], {'id': 'DEMO-1'})
        self.assertIn('state { name }', json.loads(t.calls[0][1])['query'])
        self.assertIn('status { name }', json.loads(t.calls[1][1])['query'])

    def test_slack_move_form_contains_insert_and_all_source_removals(self):
        self.assertTrue(hasattr(api, 'Slack'), 'Slack adapter missing')
        t = Transport([{'ok': True}])
        api.Slack('xoxc-secret', 'cookie', t).move('C1', 'S2', ['S0', 'S1'])
        url, body, headers = t.calls[0]
        self.assertEqual(url, 'https://slack.com/api/users.channelSections.channels.bulkUpdate')
        form = parse_qs(body.decode())
        self.assertEqual(json.loads(form['insert'][0]), [{'channel_section_id': 'S2', 'channel_ids': ['C1']}])
        self.assertEqual(len(json.loads(form['remove'][0])), 2)
        self.assertEqual(headers['Cookie'], 'd=cookie')

    def test_sections_fail_closed_on_any_incomplete_membership(self):
        self.assertTrue(hasattr(api, 'Slack'), 'Slack adapter missing')
        base = {'channel_section_id': 'S1', 'name': 'Active',
                'channel_ids_page': {'channel_ids': ['C1']}}
        for extra in [{'next_cursor': 'more'}, {'has_more': True}, {'total_count': 2}]:
            section = json.loads(json.dumps(base))
            section['channel_ids_page'].update(extra)
            with self.subTest(extra=extra):
                with self.assertRaisesRegex(ValueError, 'incomplete'):
                    api.Slack('xoxc-s', 'd', Transport([{'ok': True, 'channel_sections': [section]}])).sections()
        for response in [
            {'ok': True, 'channel_sections': [base], 'response_metadata': {'next_cursor': 'more'}},
            {'ok': True, 'channel_sections': [{'channel_section_id': 'S1'}]},
        ]:
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                api.Slack('xoxc-s', 'd', Transport([response])).sections()
        actual = api.Slack('xoxc-s', 'd', Transport([{'ok': True, 'channel_sections': [base]}])).sections()
        self.assertEqual(actual['S1']['channels'], ['C1'])

    def test_membership_counts_outside_page_and_cursor_fail_closed(self):
        base = {'channel_section_id': 'S1', 'name': 'Active',
                'channel_ids_page': {'channel_ids': ['C1']}}
        for extra in [{'channel_count': 2}, {'total_count': 2}, {'cursor': 'unhandled'},
                      {'channel_ids_page': {'channel_ids': ['C1'], 'cursor': 'unhandled'}}]:
            section = dict(base, **extra)
            with self.subTest(extra=extra), self.assertRaisesRegex(ValueError, 'incomplete'):
                api.Slack('xoxc-t', 'd', Transport([{'ok': True, 'channel_sections': [section]}])).sections()

    def test_unexpected_remote_shapes_are_clean_errors(self):
        for result in [{'data': None}, {'data': {'issue': {'id': 'id', 'state': []}}}]:
            with self.subTest(result=result), self.assertRaises(ValueError):
                api.Linear('SECRET', Transport([result])).entity('issue', 'DEMO-1')
        for result in [{'ok': True, 'channel_sections': [None]},
                       {'ok': True, 'channel_sections': [{'channel_section_id': ['bad'],
                          'channel_ids_page': {'channel_ids': []}}]}]:
            with self.subTest(result=result), self.assertRaises(ValueError):
                api.Slack('xoxc-t', 'd', Transport([result])).sections()

    def test_remote_errors_never_echo_secret_responses(self):
        self.assertTrue(hasattr(api, 'Linear'), 'adapters missing')
        for client, call in [
            (api.Linear('SECRET', Transport([{'errors': [{'message': 'SECRET'}]}])), lambda c: c.entity('issue', 'DEMO-1')),
            (api.Slack('xoxc-SECRET', 'SECRET', Transport([{'ok': False, 'error': 'SECRET'}])), lambda c: c.identity()),
        ]:
            with self.assertRaises(ValueError) as caught:
                call(client)
            self.assertNotIn('SECRET', str(caught.exception))
