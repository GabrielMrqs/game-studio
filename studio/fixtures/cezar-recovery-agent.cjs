const fs = require('fs');
fs.appendFileSync('/workspace/cezar-tool-attempts', 'attempt\n');
fs.writeFileSync('/workspace/cezar-agent-output', 'one completed tool', { flag: 'wx' });
console.log('ISOLATION_TOOL_OK');
