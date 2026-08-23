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
    putObject(key: string, obj: any): Promise<void>;
    getObject(key: string): Promise<any | null>;
    createReadStream(options?: ReadStreamOptions): NodeJS.ReadableStream;
    close(): void;
  }
}
