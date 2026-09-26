const fs = require('fs');
const path = require('path');
const policy = require('./policy-core');

const DB = path.join(__dirname, 'data', 'acl.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return JSON.parse(JSON.stringify(policy.BLANK));
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  fs.writeFileSync(DB, JSON.stringify(data, null, 2));
}

module.exports = { ...policy, load, save };
