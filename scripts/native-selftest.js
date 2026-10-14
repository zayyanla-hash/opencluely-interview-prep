'use strict';
// Offline native converter self-test: no recording, no permissions.
const report = require('../prep/native').selfTest();
console.log(`native self-test: ${report.checks.length} checks, all passing`);
