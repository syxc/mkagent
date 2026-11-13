// Bun's memoryPressure overloads hide Node 25's inherited Process event map.
import type { ProcessEventMap } from 'node:process';

declare global {
  namespace NodeJS {
    interface Process {
      on<K extends keyof ProcessEventMap>(event: K, listener: (...args: ProcessEventMap[K]) => void): this;
      once<K extends keyof ProcessEventMap>(event: K, listener: (...args: ProcessEventMap[K]) => void): this;
      prependListener<K extends keyof ProcessEventMap>(event: K, listener: (...args: ProcessEventMap[K]) => void): this;
      off<K extends keyof ProcessEventMap>(event: K, listener: (...args: ProcessEventMap[K]) => void): this;
      removeListener<K extends keyof ProcessEventMap>(event: K, listener: (...args: ProcessEventMap[K]) => void): this;
    }
  }
}
