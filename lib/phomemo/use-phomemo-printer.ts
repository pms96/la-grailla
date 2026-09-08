'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSharedPhomemoPrinter } from '@/lib/phomemo/ble';
import { isLikelyIOS, isWebBluetoothAvailable } from '@/lib/phomemo/constants';
import { fetchPhomemoPrintSettings } from '@/lib/phomemo/fetch-print-settings';
import { printTicketPdf } from '@/lib/phomemo/print-pdf';

export type PrinterStatus = 'checking' | 'unsupported' | 'disconnected' | 'connecting' | 'connected';

export function usePhomemoPrinter() {
  const [status, setStatus] = useState<PrinterStatus>('checking');
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [bleAvailable, setBleAvailable] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    const available = isWebBluetoothAvailable();
    setBleAvailable(available);
    setIsIOS(isLikelyIOS());
    setStatus(available ? 'disconnected' : 'unsupported');
  }, []);

  const bindDisconnect = useCallback(() => {
    const printer = getSharedPhomemoPrinter();
    printer.onDisconnected = () => {
      setStatus('disconnected');
      setDeviceName(null);
    };
    return printer;
  }, []);

  const connect = useCallback(async () => {
    const printer = bindDisconnect();
    setStatus('connecting');
    try {
      const name = await printer.connect();
      setDeviceName(name);
      setStatus('connected');
      return name;
    } catch (err) {
      setStatus(printer.connected ? 'connected' : 'disconnected');
      throw err;
    }
  }, [bindDisconnect]);

  const disconnect = useCallback(() => {
    const printer = getSharedPhomemoPrinter();
    printer.disconnect();
    setStatus('disconnected');
    setDeviceName(null);
  }, []);

  const printPdfBytes = useCallback(async (
    pdfBytes: ArrayBuffer,
    onPage?: (current: number, total: number) => void
  ) => {
    const printer = bindDisconnect();
    if (!printer.connected) {
      setStatus('connecting');
      try {
        const name = await printer.connect();
        setDeviceName(name);
        setStatus('connected');
      } catch (err) {
        setStatus('disconnected');
        throw err;
      }
    }
    const settings = await fetchPhomemoPrintSettings();
    await printTicketPdf(printer, pdfBytes, settings, onPage);
  }, [bindDisconnect]);

  return { status, deviceName, connect, disconnect, printPdfBytes, bleAvailable, isIOS };
}
