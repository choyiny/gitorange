// Input collection: flag -> env -> saved draft -> prompt (terminal only) -> fail naming the flag.
import * as clack from '@clack/prompts';

export type Io = {
  tty: boolean;
  prompt(
    msg: string,
    opts: {
      mask?: boolean;
      initial?: string;
      validate?: (v: string) => string | undefined;
    }
  ): Promise<string | null>;
  select<T>(msg: string, options: { value: T; label: string }[]): Promise<T>;
  confirm(msg: string, initial: boolean): Promise<boolean>;
  print(text: string): void;
};

export const clackIo: Io = {
  tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  async prompt(msg, opts) {
    const options = {
      message: msg,
      validate: opts.validate
        ? (v?: string) => opts.validate!(v ?? '')
        : undefined,
    };
    const v = opts.mask
      ? await clack.password(options)
      : await clack.text({ ...options, initialValue: opts.initial });
    return clack.isCancel(v) ? null : v;
  },
  async select<T>(msg: string, options: { value: T; label: string }[]) {
    const v = await clack.select<T>({
      message: msg,
      options: options as never,
    });
    if (clack.isCancel(v)) throw new Error('Cancelled.');
    return v as T;
  },
  async confirm(msg, initial) {
    const v = await clack.confirm({ message: msg, initialValue: initial });
    if (clack.isCancel(v)) throw new Error('Cancelled.');
    return v;
  },
  print(text) {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  },
};

export async function collect(
  io: Io,
  o: {
    flag?: string;
    env?: string;
    draft?: string;
    message: string;
    mask?: boolean;
    validate?: (v: string) => string | undefined;
    flagName: string;
  }
): Promise<string> {
  const given = [o.flag, o.env, o.draft].find(
    (v) => v !== undefined && v !== ''
  );
  if (given !== undefined) {
    const bad = o.validate?.(given);
    if (bad) throw new Error(bad);
    return given;
  }
  if (!io.tty)
    throw new Error(
      `${o.flagName} is required when not running in a terminal.`
    );
  const v = await io.prompt(o.message, { mask: o.mask, validate: o.validate });
  if (v === null) throw new Error('Cancelled.');
  return v;
}
