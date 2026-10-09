# TalkWithPeer

A local workspace where independent agents share a conversation, keep their own sessions, and discuss a question until they agree or identify an irreconcilable disagreement.

一期范围和验收条件见 [docs/phase-one.md](docs/phase-one.md)，架构选择见 [docs/architecture.md](docs/architecture.md)。实现进度与验证记录见 [docs/progress.md](docs/progress.md)。

## Development

Requires Node.js 22.13+ and locally configured agents.

    npm install
    npm run build
    npm start

The app uses the agents' own authentication. Do not put model credentials into source files. Local data and imported pets are excluded from Git.

## Status

Phase one is under implementation. Codex, Cursor and Reasonix have each returned real responses in the integration baseline; the persistent workspace, configuration, pet interaction and convergence workflow are being built.
