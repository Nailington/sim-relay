import type { HostEntry, Inventory } from '../shared/types';
export const demoHosts: HostEntry[] = [
  { id: 'demo-studio', name: 'Studio Mac', url: 'https://studio-mac.local:49300', source: 'demo' },
  {
    id: 'demo-macbook',
    name: 'MacBook Pro',
    url: 'https://macbook-pro.local:49300',
    source: 'demo',
  },
];
const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0';
export const demoInventory: Inventory = {
  devices: [
    {
      udid: 'demo-iphone-17',
      name: 'iPhone 17 Pro',
      state: 'Booted',
      runtime: 'iOS 26.0',
      deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
    },
    {
      udid: 'demo-iphone-16',
      name: 'iPhone 16',
      state: 'Shutdown',
      runtime: 'iOS 26.0',
      deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
    },
    {
      udid: 'demo-ipad',
      name: 'iPad Pro 11-inch',
      state: 'Shutdown',
      runtime: 'iOS 26.0',
      deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4-8GB',
    },
  ],
  runtimes: [{ identifier: runtime, name: 'iOS 26.0', version: '26.0', isAvailable: true }],
  devicetypes: [
    {
      identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      name: 'iPhone 17 Pro',
      productFamily: 'iPhone',
    },
    {
      identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
      name: 'iPhone 16',
      productFamily: 'iPhone',
    },
    {
      identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4-8GB',
      name: 'iPad Pro 11-inch',
      productFamily: 'iPad',
    },
  ],
};
