import { StateField } from '@codemirror/state';
export const editorLivePreviewField = StateField.define({ create: () => false, update: value => value });
export const editorInfoField = StateField.define({ create: () => ({}), update: value => value });
export const Platform = { isMobileApp: true };
export class App {}
export class TFile { extension = 'md'; constructor(public path: string) {} get basename() { return this.path.split('/').at(-1)!.replace(/\.[^.]+$/, ''); } }
export class TFolder { constructor(public path: string) {} }
export class MarkdownView { file?: TFile; editor: any; getMode() { return 'source'; } async save() {} }
export class Plugin { app: any; async saveData(_data: unknown) {} }
export class PluginSettingTab { containerEl: any; constructor(..._args: any[]) {} }
export class MarkdownRenderChild { constructor(..._args: any[]) {} }
export class Modal { constructor(..._args: any[]) {} }
export class Setting { constructor(..._args: any[]) {} }
export class Notice { constructor(..._args: any[]) {} }
export class Menu {}
export const normalizePath = (value: string) => value.replace(/\\/g, '/');
export type Editor = any;
