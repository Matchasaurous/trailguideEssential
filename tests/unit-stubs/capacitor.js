// Minimal @capacitor/* stand-ins so app modules load in Node for unit tests.
export const Capacitor = { isNativePlatform: () => false, getPlatform: () => 'web' };
export const CapacitorHttp = { request: async () => ({ status: 200, data: null }) };
export function registerPlugin() { return null; }
export const App = { addListener: () => ({ remove() {} }) };
export const LocalNotifications = {
  checkPermissions: async () => ({ display: 'granted' }),
  requestPermissions: async () => ({ display: 'granted' }),
  createChannel: async () => {},
  schedule: async () => {},
  cancel: async () => {},
  addListener: () => ({ remove() {} })
};
