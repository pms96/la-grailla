/**
 * Tipos mínimos de Web Bluetooth para no depender del paquete @types/web-bluetooth
 * en un módulo que solo se usa en el cliente.
 */
export type BluetoothServiceUUID = number | string;

export type BluetoothRequestDeviceFilter = {
  namePrefix?: string;
  services?: BluetoothServiceUUID[];
};

export type BluetoothRemoteGATTCharacteristic = {
  properties: { write: boolean; writeWithoutResponse: boolean };
  writeValue: (data: BufferSource) => Promise<void>;
  writeValueWithoutResponse: (data: BufferSource) => Promise<void>;
  getCharacteristic?: never;
};

export type BluetoothRemoteGATTService = {
  getCharacteristic: (uuid: BluetoothServiceUUID) => Promise<BluetoothRemoteGATTCharacteristic>;
};

export type BluetoothRemoteGATTServer = {
  connected: boolean;
  connect: () => Promise<BluetoothRemoteGATTServer>;
  disconnect: () => void;
  getPrimaryService: (uuid: BluetoothServiceUUID) => Promise<BluetoothRemoteGATTService>;
};

export type BluetoothDevice = {
  name?: string;
  gatt?: BluetoothRemoteGATTServer;
  addEventListener: (type: 'gattserverdisconnected', listener: () => void) => void;
};

export type BluetoothNavigator = {
  requestDevice: (options: {
    filters?: BluetoothRequestDeviceFilter[];
    acceptAllDevices?: boolean;
    optionalServices?: BluetoothServiceUUID[];
  }) => Promise<BluetoothDevice>;
};
