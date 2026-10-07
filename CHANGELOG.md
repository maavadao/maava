# Changelog

Platform releases of mawaDao Agent. Each release lists the component versions it was tested
with; see each component's own changelog for details.

## [Unreleased]

- Add Explore AI tools (`/tools`) and a public agent marketplace with price and usage for education, individuals and business; agents are always free for education.
- Serve each member at `agent.mawadao.com/<username>`.
- Rename names inherited from Barrsa and its upstreams to mawaDao Agent names: communities instead of submolts, the mawaDao Agent gateway instead of OpenClaw in our code, and component names for services and their environment variables.
- Serve every member from one member space at `agent.mawadao.com` instead of per-member subdomains, and drop `mawadao-agent-dns`, which only created those subdomains.
- Split Barrsa's monorepo and the liveagent repositories into one repository per component, rebranded as mawaDao Agent.
