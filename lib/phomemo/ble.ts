import { PHOMEMO_BLE, isWebBluetoothAvailable } from './constants';
import type { BluetoothDevice, BluetoothNavigator, BluetoothRemoteGATTCharacteristic } from './ble-types';
import { buildM04SCommandSequence } from './m04s-protocol';
import type { MonoRaster } from './raster';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bluetooth(): BluetoothNavigator {
  const api = (navigator as Navigator & { bluetooth?: BluetoothNavigator }).bluetooth;
  if (!api) throw new Error('Este navegador no puede hablar por Bluetooth con la impresora');
  return api;
}

function toWriteBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

/**
 * Conexión BLE a una Phomemo M04S (servicio 0xff00, escritura 0xff02).
 * Un clic de usuario tiene que disparar connect() — el selector de Bluetooth lo exige.
 */
export class PhomemoM04S {
  private device: BluetoothDevice | null = null;
  private writeChar: BluetoothRemoteGATTCharacteristic | null = null;
  private useWriteWithResponse = false;
  private disconnectHandlerBound: BluetoothDevice | null = null;
  onDisconnected: (() => void) | null = null;

  static isAvailable(): boolean {
    return isWebBluetoothAvailable();
  }

  get connected(): boolean {
    return Boolean(this.device?.gatt?.connected && this.writeChar);
  }

  get name(): string | null {
    return this.device?.name ?? null;
  }

  async connect(): Promise<string> {
    if (this.connected) return this.name ?? 'M04S';

    const bt = bluetooth();
    const optionalServices = [...PHOMEMO_BLE.ALT_SERVICE_UUIDS];

    if (this.device?.gatt && !this.device.gatt.connected) {
      try {
        this.bindDisconnect(this.device);
        await this.openGattWithRetry(this.device);
        return this.name ?? 'M04S';
      } catch {
        this.device = null;
      }
    }

    try {
      this.device = await bt.requestDevice({
        filters: [{ namePrefix: 'M04' }, { namePrefix: 'M' }, { namePrefix: 'Phomemo' }],
        optionalServices,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message.toLowerCase().includes('cancel') || (err instanceof Error && err.name === 'NotFoundError')) {
        throw new Error('cancelled');
      }
      this.device = await bt.requestDevice({ acceptAllDevices: true, optionalServices });
    }

    this.bindDisconnect(this.device);
    await this.openGattWithRetry(this.device);
    return this.name ?? 'M04S';
  }

  disconnect(): void {
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* ya estaba suelta */
    }
    this.writeChar = null;
  }

  async printRaster(raster: MonoRaster): Promise<void> {
    if (!this.connected) await this.connect();
    const job = buildM04SCommandSequence(raster);

    for (const cmd of job.preamble) {
      await this.send(cmd);
      await delay(job.delays.command);
    }

    const rasterChunk = PHOMEMO_BLE.RASTER_CHUNK_SIZE;
    for (let i = 0; i < job.raster.length; i += rasterChunk) {
      await this.send(job.raster.subarray(i, i + rasterChunk));
      await delay(job.delays.rasterChunk);
    }

    await delay(job.delays.afterRaster);
    for (const feed of job.feed) {
      await this.send(feed);
      await delay(job.delays.command);
    }
    await delay(job.delays.afterFeed);
  }

  private bindDisconnect(device: BluetoothDevice): void {
    if (this.disconnectHandlerBound === device) return;
    this.disconnectHandlerBound = device;
    device.addEventListener('gattserverdisconnected', () => {
      this.writeChar = null;
      this.onDisconnected?.();
    });
  }

  private async openGattWithRetry(device: BluetoothDevice): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= PHOMEMO_BLE.MAX_RETRIES; attempt++) {
      try {
        await this.openGatt(device);
        return;
      } catch (err) {
        lastError = err;
        if (attempt < PHOMEMO_BLE.MAX_RETRIES) {
          await delay(PHOMEMO_BLE.INITIAL_RETRY_DELAY_MS * 2 ** attempt);
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('No se pudo abrir la conexión Bluetooth con la impresora');
  }

  private async openGatt(device: BluetoothDevice): Promise<void> {
    const server = await device.gatt!.connect();
    await delay(100);

    let lastError: unknown;
    for (const uuid of PHOMEMO_BLE.ALT_SERVICE_UUIDS) {
      try {
        const service = await server.getPrimaryService(uuid);
        this.writeChar = await service.getCharacteristic(PHOMEMO_BLE.WRITE_CHAR_UUID);
        this.useWriteWithResponse = !this.writeChar.properties.writeWithoutResponse && this.writeChar.properties.write;
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      lastError instanceof Error ? lastError.message : 'La impresora no expone el servicio Bluetooth de Phomemo'
    );
  }

  private async send(data: Uint8Array): Promise<void> {
    if (!this.writeChar) throw new Error('Impresora desconectada');
    const buffer = toWriteBuffer(data);
    if (this.useWriteWithResponse) {
      await this.writeChar.writeValue(buffer);
      return;
    }
    try {
      await this.writeChar.writeValueWithoutResponse(buffer);
    } catch {
      this.useWriteWithResponse = true;
      await this.writeChar.writeValue(buffer);
    }
  }
}

let shared: PhomemoM04S | null = null;

export function getSharedPhomemoPrinter(): PhomemoM04S {
  if (!shared) shared = new PhomemoM04S();
  return shared;
}
