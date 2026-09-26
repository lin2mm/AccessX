/**
 * Driver registry —— 唯一决定"这套系统跑在谁家硬件上"的地方
 *
 * 切换方式：环境变量 LOCK_VENDOR=ttlock|demo
 * 不设 → 自动选择：有 TTLock 凭证走 ttlock，没有走 demo。
 *
 * 加新厂商（Tuya / 自研 BLE / Salto）只需要：
 *   1. 写 drivers/xxx.driver.js 继承 LockDriver
 *   2. 在下面 REGISTRY 加一行
 * server.js 一行都不用改。
 */
const { LockDriver, UnsupportedOperation, METHOD } = require('./base');
const { TTLockDriver } = require('./ttlock.driver');
const { DemoDriver } = require('./demo.driver');

const REGISTRY = {
  ttlock: TTLockDriver,
  demo: DemoDriver,
  // tuya:  require('./tuya.driver').TuyaDriver,     // 未实现
  // ble:   require('./ble.driver').BleDriver,       // 未实现，法律状态待定
};

function pickVendor() {
  const explicit = (process.env.LOCK_VENDOR || '').toLowerCase();
  if (explicit && REGISTRY[explicit]) return explicit;
  if (explicit) {
    console.warn(`[drivers] unknown LOCK_VENDOR="${explicit}", falling back`);
  }
  const hasTT = process.env.TTLOCK_CLIENT_ID && process.env.TTLOCK_CLIENT_SECRET
             && process.env.TTLOCK_USER && process.env.TTLOCK_PASS;
  return hasTT ? 'ttlock' : 'demo';
}

let _driver = null;
function getDriver() {
  if (_driver) return _driver;
  const vendor = pickVendor();
  _driver = new REGISTRY[vendor]();
  console.log(`[drivers] active vendor: ${vendor}`);
  return _driver;
}

module.exports = {
  getDriver,
  availableVendors: () => Object.keys(REGISTRY),
  LockDriver, UnsupportedOperation, METHOD,
};
