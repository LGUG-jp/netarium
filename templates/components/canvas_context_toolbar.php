    <div
        id="canvas-context-toolbar"
        class="canvas-context-toolbar"
        hidden
        role="toolbar"
        aria-label="キャンバス操作"
        aria-hidden="true"
    >
        <div
            class="canvas-context-toolbar-content"
            data-canvas-context="floor-plan"
            aria-label="フロア図面調整"
            hidden
        >
            <strong>図面調整</strong>
            <label class="floor-plan-toolbar-opacity" for="floor-plan-opacity">不透明度
                <input id="floor-plan-opacity" type="range" min="10" max="100" step="1" value="100"
                    aria-describedby="floor-plan-opacity-value">
                <output id="floor-plan-opacity-value" for="floor-plan-opacity">100%</output>
            </label>
            <span id="floor-plan-temporary-visible" class="form-support" role="status" hidden>非表示の図面を一時表示中</span>
            <div class="floor-plan-toolbar-actions" role="group" aria-label="図面調整の操作">
                <button id="floor-plan-reset-btn" type="button" class="btn btn-secondary btn-sm"
                    title="位置を原点、サイズを100%へ戻します。不透明度と表示状態は保持します">位置・サイズをリセット</button>
                <details class="floor-plan-toolbar-help">
                    <summary class="btn btn-tertiary btn-sm">？使い方</summary>
                    <div class="floor-plan-toolbar-help-content" id="floor-plan-editor-help">
                        <p>図面本体をドラッグで移動、四隅で拡大縮小します。ホイールはCanvasのズームです。</p>
                        <p>図面にフォーカスして矢印キーで移動（Shiftで10倍）。四隅にフォーカスして上/右で拡大、下/左で縮小（1%、Shiftで10%）できます。</p>
                        <p>図面のサイズは5〜200%、不透明度は10%（薄い）〜100%（不透明）です。確定操作ごとに自動保存します。</p>
                        <p>Escは操作中の移動・リサイズだけを取り消します。操作中でなければ調整を終了します。「完了」でも終了します。確定済みの変更は戻しません。</p>
                        <p>保存失敗はフッターで確認し、「保存」で再試行できます。未確認の保存は「保存状態を確認」、競合はビュー管理の再読込を使います。</p>
                    </div>
                </details>
                <button id="floor-plan-finish-btn" type="button" class="btn btn-primary btn-sm"
                    >完了</button>
            </div>
        </div>
        <div class="canvas-context-toolbar-content link-route-toolbar"
            data-canvas-context="link-route" aria-label="接続経路編集" hidden>
            <div class="link-route-toolbar-summary">
                <strong>経路調整</strong>
            </div>
            <div class="link-route-toolbar-actions" role="group" aria-label="折れの調整">
                <button id="link-route-add-btn" type="button" class="btn btn-secondary btn-sm">折れを追加</button>
                <button id="link-route-remove-btn" type="button" class="btn btn-danger btn-secondary btn-sm">折れを削除</button>
            </div>
            <div class="link-route-toolbar-actions" role="group" aria-label="調整の終了">
                <button id="link-route-finish-btn" type="button" class="btn btn-primary btn-sm">完了</button>
            </div>
        </div>
        <div class="canvas-context-toolbar-content canvas-note-toolbar"
            data-canvas-context="canvas-note" aria-label="メモの編集" hidden>
            <strong>メモ</strong>
            <div class="canvas-note-toolbar-field">
                <span>背景色</span>
                <div class="canvas-note-color-control">
                    <button id="note-background-color" type="button" class="canvas-note-color-trigger"
                        aria-label="背景色" aria-haspopup="menu" aria-expanded="false" aria-controls="note-background-color-options">
                        <span class="canvas-note-color-swatch" aria-hidden="true" data-color="#FFF3B0"></span>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" stroke-width="1.5"/></svg>
                    </button>
                    <div id="note-background-color-options" class="canvas-note-color-options" role="menu" aria-label="背景色" hidden>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#FFF3B0" aria-label="黄" title="黄"></button>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#FCE7F3" aria-label="ピンク" title="ピンク"></button>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#FFEDD5" aria-label="オレンジ" title="オレンジ"></button>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#DCFCE7" aria-label="緑" title="緑"></button>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#DBEAFE" aria-label="青" title="青"></button>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#EDE9FE" aria-label="紫" title="紫"></button>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#E5E7EB" aria-label="グレー" title="グレー"></button>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#FFFFFF" aria-label="白" title="白"></button>
                    </div>
                </div>
            </div>
            <label class="canvas-note-toolbar-field" for="note-opacity">透明度
                <input id="note-opacity" type="range" min="20" max="100" step="1" value="85"
                    aria-describedby="note-opacity-value">
                <output id="note-opacity-value" for="note-opacity">85%</output>
            </label>
            <label class="canvas-note-toolbar-field" for="note-font-size">文字サイズ
                <input id="note-font-size" type="number" min="12" max="32" step="1" value="14">
                <span>px</span>
            </label>
            <div class="canvas-note-toolbar-field">
                <span>文字色</span>
                <div class="canvas-note-color-control">
                    <button id="note-text-color" type="button" class="canvas-note-color-trigger"
                        aria-label="文字色" aria-haspopup="menu" aria-expanded="false" aria-controls="note-text-color-options">
                        <span class="canvas-note-color-swatch" aria-hidden="true" data-color="#263238"></span>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" stroke-width="1.5"/></svg>
                    </button>
                    <div id="note-text-color-options" class="canvas-note-color-options" role="menu" aria-label="文字色" hidden>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#263238" aria-label="黒" title="黒"></button>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#FFFFFF" aria-label="白" title="白"></button>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#B91C1C" aria-label="赤" title="赤"></button>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#1D4ED8" aria-label="青" title="青"></button>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#6B7280" aria-label="グレー" title="グレー"></button>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#166534" aria-label="緑" title="緑"></button>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#7E22CE" aria-label="紫" title="紫"></button>
                        <button type="button" class="canvas-note-color-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-color="#92400E" aria-label="茶" title="茶"></button>
                    </div>
                </div>
            </div>
            <div class="canvas-note-toolbar-actions" role="group" aria-label="メモの操作">
                <button id="note-delete-btn" type="button" class="btn btn-danger btn-secondary btn-sm">削除</button>
                <button id="note-finish-btn" type="button" class="btn btn-primary btn-sm">完了</button>
            </div>
        </div>
    </div>

    <div id="link-route-help-overlay" class="placement-manager-overlay" hidden>
        <section id="link-route-help-dialog" class="placement-manager-dialog link-route-help-dialog"
            role="dialog" aria-modal="true" aria-labelledby="link-route-help-title" tabindex="-1">
            <header class="placement-manager-header">
                <h2 id="link-route-help-title">経路調整の使い方</h2>
                <button id="link-route-help-close-btn" type="button" class="modal-close-btn"
                    aria-label="閉じる">×</button>
            </header>
            <div class="link-route-help-content">
                <p id="link-route-help">区間を選んでドラッグします。水平区間は上下、垂直区間は左右へ動かせます。</p>
                <ul>
                    <li>自動経路は開始時に手動経路へ切り替えて自動保存します。斜線は水平・垂直の経路になります。</li>
                    <li>選んだ区間の「折れを追加」「折れを削除」で曲がりを増減します。折れは最大8点です。選択区間や経路の形によって使えない操作は無効になります。</li>
                    <li>矢印キーでも移動できます。Shiftを併用すると移動量が10倍になります。</li>
                    <li>操作の確定ごとに経路の変更を自動保存します。保存中も調整を続けられます。右パネルの未適用の属性は保存しません。</li>
                    <li>「完了」で調整を終了します。調整中のESCはドラッグ中の変更だけを取り消して終了し、確定済みの変更は戻しません。</li>
                    <li>機器の移動で生じた折り返しは「折れを削除」で調整します。手動の調整をすべて破棄する場合は、右パネルの「自動経路」を使います。自動経路では無効、調整開始後や手動経路では有効になります。</li>
                </ul>
            </div>
        </section>
    </div>
