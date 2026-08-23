declare module '@vijayee/wavedb' {
  export interface WaveDBOptions {
    delimiter?: string;
    wal?: { syncMode?: string };
    [key: string]: any;
  }

  export interface ReadStreamOptions {
    start?: string;
    end?: string;
    reverse?: boolean;
    keys?: boolean;
    values?: boolean;
    keyAsArray?: boolean;
    delimiter?: string;
  }

  export class WaveDB {
    constructor(path: string, options?: WaveDBOptions);
    put(key: string, value: string | Buffer): Promise<void>;
    get(key: string): Promise<string | Buffer | null>;
    getMany(keys: string[]): Promise<Array<string | Buffer | null>>;
    putObject<T>(key: string, obj: T): Promise<void>;
    getObject<T>(key: string): Promise<T | null>;
    createReadStream(options?: ReadStreamOptions): NodeJS.ReadableStream;
    close(): void;
  }
}
