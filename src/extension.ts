import * as path from 'path';
import * as fs from 'fs';
import { ExtensionContext, window, commands, Range } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand('type', async (args: { text: string }) => {
      const editor = window.activeTextEditor;

      if (!editor || editor.document.languageId !== 'voidflag') {
        await commands.executeCommand('default:type', args);
        return;
      }

      const pairs: Record<string, string> = { '{': '}', '"': '"' };
      const closing = pairs[args.text];

      if (!closing) {
        await commands.executeCommand('default:type', args);
        return;
      }

      const selections = editor.selections;
      await editor.edit((editBuilder) => {
        for (const sel of selections) {
          if (args.text === '"') {
            const pos = sel.active;
            const charAfter = editor.document.getText(
              new Range(pos, pos.translate(0, 1)),
            );
            if (charAfter === '"' && sel.isEmpty) {
              return;
            }
          }
          editBuilder.replace(sel, args.text + closing);
        }
      });

      editor.selections = editor.selections.map((sel) => {
        const pos = sel.active.translate(0, -closing.length);
        return new (require('vscode').Selection)(pos, pos);
      });
    }),
  );

  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));

  if (!fs.existsSync(serverModule)) {
    window.showErrorMessage(
      `VoidFlag: server.js not found at ${serverModule}. Run pnpm build.`,
    );
    return;
  }

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc, runtime: 'node' },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      runtime: 'node',
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'voidflag' }],
  };

  client = new LanguageClient(
    'voidflag',
    'VoidFlag Language Server',
    serverOptions,
    clientOptions,
  );
  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
