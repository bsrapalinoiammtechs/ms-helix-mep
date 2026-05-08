type LogData = Record<string, unknown>;

const fmt = (level: string, event: string, data: LogData) =>
  JSON.stringify({ ts: new Date().toISOString(), level, event, ...data });

export const log = {
  info: (event: string, data: LogData = {}) => {
    console.log(fmt("info", event, data));
  },
  warn: (event: string, data: LogData = {}) => {
    console.warn(fmt("warn", event, data));
  },
  error: (event: string, data: LogData = {}) => {
    console.error(fmt("error", event, data));
  },
};

export default log;
