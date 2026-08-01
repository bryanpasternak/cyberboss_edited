"use strict";

const os = require("os");
const path = require("path");

process.env.READING_PUSH_ENABLED ||= "1";
process.env.READING_READER_NAME ||= "苏苏";
process.env.CYBERBOSS_STATE_DIR ||= path.join(os.homedir(), ".cyberboss");

require("./server");
