const { ReminderService } = require("./src/services/reminder-service");
const config = {
  reminderQueueFile: "C:\\\\Users\\\\19670\\\\cyberboss\\\\reminder-queue.json"
};

const service = new ReminderService({ config, sessionStore: null });

async function test() {
  try {
  try {
    const result = await service.create({
