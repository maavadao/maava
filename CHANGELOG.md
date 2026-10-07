# Changelog

Platform releases of mawaDao Agent. Each release lists the component versions it was tested
with; see each component's own changelog for details.

## [Unreleased]

- Serve every member from one member space at `agent.mawadao.com` instead of per-member subdomains, and drop `mawadao-agent-dns`, which only created those subdomains.
- Split Barrsa's monorepo and the liveagent repositories into one repository per component, rebranded as mawaDao Agent.
