import { App, Modal } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import * as React from "react";

import type FastSync from "../main";
import { $ } from "../i18n/lang";
import { LucideIcon } from "./note-history/lucide-icon";
import { WSClient } from "../lib/api";

export class WSClientsModal extends Modal {
    private root: Root | null = null;
    private plugin: FastSync;

    constructor(app: App, plugin: FastSync) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        this.titleEl.setText($("ui.system.websocketClients"));
        this.containerEl.addClass("fns-ws-clients-modal-container");

        this.root = createRoot(contentEl);
        this.root.render(
            <WSClientsView plugin={this.plugin} />
        );
    }

    onClose() {
        this.containerEl.removeClass("fns-ws-clients-modal-container");
        if (this.root) {
            this.root.unmount();
            this.root = null;
        }
        this.contentEl.empty();
    }
}

const WSClientsView = ({ plugin }: { plugin: FastSync }) => {
    const [clients, setClients] = React.useState<WSClient[]>([]);
    const [isLoading, setIsLoading] = React.useState(true);

    const loadClients = async () => {
        setIsLoading(true);
        const data = await plugin.api.getWSClients();
        setClients(data);
        setIsLoading(false);
    };

    React.useEffect(() => {
        loadClients();
    }, []);

    return (
        <div className="fns-ws-clients-view">
            <div className="fns-ws-clients-header">
                <div className="fns-ws-clients-title-group">
                    <LucideIcon icon="monitor" size={20} />
                    {$("ui.system.websocketClients")}
                </div>
                <div className="fns-ws-clients-stats-group">
                    {clients.length > 0 && (
                        <span className="fns-ws-clients-count-badge">
                            {clients.length} {$("ui.system.wsClientName")}
                        </span>
                    )}
                    <button 
                        className="clickable-icon fns-ws-clients-refresh-btn" 
                        onClick={loadClients} 
                        disabled={isLoading}
                        aria-label={$("ui.common.refresh")}
                    >
                        <LucideIcon icon="refresh-cw" size={16} className={isLoading ? "is-spinning" : ""} />
                    </button>
                </div>
            </div>

            <div className="fns-ws-clients-list">
                {clients.length === 0 ? (
                    <div className="fns-ws-clients-empty-state">
                        {isLoading ? (
                            <div className="fns-ws-clients-loading-indicator">
                                <LucideIcon icon="loader-2" className="is-spinning" size={16} />
                                <span>{$("ui.history.loading")}</span>
                            </div>
                        ) : (
                            $("ui.system.wsNoClients")
                        )}
                    </div>
                ) : (
                    clients.map((client) => (
                        <div key={client.traceId} className="fns-ws-clients-item">
                            <div className="fns-ws-clients-item-top">
                                <div className="fns-ws-clients-item-main">
                                    <div className="fns-ws-clients-item-icon-wrapper">
                                        <LucideIcon icon={client.platformInfo?.isMobile ? "smartphone" : "laptop"} size={16} style={{ color: 'var(--text-accent)' }} />
                                    </div>
                                    <div className="fns-ws-clients-item-identity">
                                        <div className="fns-ws-clients-item-name-row">
                                            {client.clientName || client.nickname || $("ui.common.na")}
                                            <span className="fns-ws-clients-item-version-tag">v{client.clientVersion}</span>
                                        </div>
                                        <div className="fns-ws-clients-item-address-line">
                                            {client.remoteAddr}
                                        </div>
                                    </div>
                                </div>
                                <span className="fns-ws-clients-item-type-tag">
                                    {client.clientType}
                                </span>
                            </div>
                            <div className="fns-ws-clients-item-bottom">
                                <div className="fns-ws-clients-item-timestamp">
                                    {$("ui.system.wsStartTime")}: {client.startTime ? new Date(client.startTime).toLocaleString() : $("ui.common.na")}
                                </div>
                                <div className="fns-ws-clients-item-uid-info">
                                    UID: {client.uid}
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};
