#!/usr/bin/env node
import type { ExitCode } from '@yuki-byte18/shared';
import { EXIT_CODES, toPerfPilotError } from '@yuki-byte18/shared';
import { buildProgram } from './main.js';

/**
 * bin shim。
 *
 * 这里只做三件事：解析、等待、按退出码结束进程。
 * 所有业务逻辑在 main.ts 与 commands/ 里，因此它们都能被直接测试。
 */
let exitCode: ExitCode = EXIT_CODES.OK;

const program = buildProgram({
  onExit: (code) => {
    exitCode = code;
  },
});

try {
  await program.parseAsync(process.argv);
} catch (err) {
  const error = toPerfPilotError(err);
  process.stdout.write(`\n❌ ${error.code}: ${error.message}\n`);
  exitCode = EXIT_CODES.INTERNAL;
}

// commander 在 --help / --version 时也会走到这里，退出码保持 0
process.exitCode = exitCode;
