import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client';
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client';
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
    /** Generated Remote namespaces selected by this Client assembly. */
    remote: ClientRemote;
    get<T>(service: string): T;
    effect(effect: () => void | (() => void), label?: string): void;
    sessions: ISessions;
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
//# sourceMappingURL=index.d.ts.map