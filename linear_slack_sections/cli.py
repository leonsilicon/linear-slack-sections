"""Local-first CLI. Credentials are read only from the environment."""
import argparse
import json
import math
import os
from pathlib import Path
import sys
import time

from .api import Http, Linear, Slack
from .core import sync, validate


def credential(env, name, prefix=None):
    value = env.get(name)
    if not value:
        raise ValueError('missing environment variable: ' + name)
    if not isinstance(value, str) or any(ord(c) < 33 or ord(c) > 126 for c in value) or (
            prefix and not value.startswith(prefix)) or (name == 'SLACK_D_COOKIE' and (';' in value or '=' in value)):
        raise ValueError('invalid credential format: ' + name)
    return value


def main(argv=None, *, env=None, transport=None, sleep=time.sleep):
    parser = argparse.ArgumentParser(description='Reconcile explicit Linear issues/projects to personal Slack sections; preview by default.')
    parser.add_argument('--config', type=Path, required=True, help='JSON config (never credentials)')
    parser.add_argument('--state', type=Path, default=Path.home() / '.local/state/linear-slack-sections/state.json')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true', help='authorize channel/section creation and moves')
    mode.add_argument('--dry-run', action='store_true', help='read-only preview (the default)')
    parser.add_argument('--watch', action='store_true', help='poll until interrupted; stops on any error')
    parser.add_argument('--interval', type=float, default=60, help='poll seconds, minimum 10 (default: 60)')
    args = parser.parse_args(argv)
    try:
        if not math.isfinite(args.interval) or args.interval < 10:
            raise ValueError('interval must be finite and at least 10 seconds')
        try:
            config = json.loads(args.config.read_text())
        except (ValueError, UnicodeError):
            raise ValueError('invalid config JSON') from None
        validate(config)
        env = os.environ if env is None else env
        linear_token = credential(env, 'LINEAR_API_KEY')
        token = credential(env, 'SLACK_XOXC_TOKEN', 'xoxc-')
        cookie = credential(env, 'SLACK_D_COOKIE')
        transport = Http() if transport is None else transport
        linear, slack = Linear(linear_token, transport), Slack(token, cookie, transport)
        bot = None
        if env.get('SLACK_BOT_TOKEN'):
            bot = Slack(credential(env, 'SLACK_BOT_TOKEN', 'xoxb-'), None, transport)
        while True:
            plan = sync(config, linear, slack, args.state, apply=args.apply, bot=bot)
            print(json.dumps({'mode': 'apply' if args.apply else 'preview', 'changes': plan}), flush=True)
            if not args.watch:
                return 0
            sleep(args.interval)
    except KeyboardInterrupt:
        return 0
    except (ValueError, OSError) as exc:
        # Only our deliberately sanitized ValueErrors are exposed. OS errors can contain private paths.
        print('error: ' + (str(exc) if isinstance(exc, ValueError) else 'local file or I/O operation failed'), file=sys.stderr)
        return 1
