# Ghost Jon — TUI Capabilities

## ThunderBrowser (AVAILABLE)
Use these by calling the CLI commands from within your response context:
- Navigate: `thundergate browser navigate <url>`
- Read page: `thundergate browser read`
- Extract element: `thundergate browser extract <selector>`
- Evaluate JS: `thundergate browser eval "<expression>"`
- Get state: `thundergate browser state`

## Rules
- NEVER touch /home/ubuntu/.openclaw/ files
- NEVER modify openclaw.json or any OpenClaw config
- NEVER run git push without explicit user approval
- CAN read files in /home/ubuntu/thundergate-dev/
- CAN run thundergate CLI commands
- CAN use ThunderBrowser to fetch and read web content
