/** Keep legacy JavaScript inputs open without losing array or scalar inference. */
type LegacyResult<T> = null extends T ? any
  : undefined extends T ? any
  : T extends Promise<infer Value> ? Promise<LegacyResult<Value>>
  : T extends readonly unknown[] ? any[]
  : T extends object ? any
  : T;

export type LegacyConstructor<T> = new (...args: any[]) => {
  [Key in keyof T]: T[Key] extends (...args: any[]) => infer Result
    ? (...args: any[]) => LegacyResult<Result>
    : any;
} & Record<string, any>;
