import { PtyCreateOptions, PtyCreateResult } from '../shared/types';

declare global {
  interface Window {
    electronAPI: {
      ptyCreate: (opts: PtyCreateOptions) => Promise<PtyCreateResult>;
      ptyWrite: (id: string, data: string) => void;
      ptyResize: (id: string, cols: number, rows: number) => void;
      ptyKill: (id: string) => Promise<void>;
      onPtyData: (id: string, cb: (data: string) => void) => () => void;
      onPtyExit: (id: string, cb: (code: number) => void) => () => void;
      pickDirectory: () => Promise<string | null>;
    };
  }
}
