import type { IWorkspaces, SessionStoreService, SlotRegistry } from './compat.ts';
export declare const name = "dsh-session-manager/client";
export declare const inject: string[];
/** Locale namespace id registered under ctx.locale. */
export declare const NS = "dsh-session-manager";
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** The session-manager settings-section navigation label. */
        [NS]: 'nav';
    }
}
export declare function apply(ctx: ClientContext): void;
interface ClientContext {
    slots: SlotRegistry;
    get<T>(service: string): T;
    effect(effect: () => void | (() => void), label?: string): void;
    sessions: SessionStoreService;
    workspaces: IWorkspaces;
    locale: {
        getLocale(): {
            active: string;
        };
        subscribe(listener: () => void): () => void;
        register(namespace: string, dictionaries: Record<'zh' | 'en', Record<string, string>>): () => void;
        bind(namespace: string): (key: 'nav') => string;
    };
}
export {};
