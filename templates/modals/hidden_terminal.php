<div id="hidden-terminal-overlay" class="placement-manager-overlay hidden-terminal-overlay" hidden>
    <section class="placement-manager-dialog hidden-terminal-dialog" role="dialog" aria-modal="true"
        aria-labelledby="hidden-terminal-title" aria-describedby="hidden-terminal-description" tabindex="-1">
        <header class="placement-manager-header">
            <h2 id="hidden-terminal-title">隠されたポートが見つかりました。</h2>
            <button id="hidden-terminal-close" type="button" class="modal-close-btn" aria-label="閉じる">×</button>
        </header>
        <div id="hidden-terminal-discovery" class="hidden-terminal-discovery">
            <p>どうやら、Netariumにはまだ秘密があるようです。<br>
                この先に、業務に役立つ機能はありません。<br>
                それでも覗いてみますか？</p>
            <div class="hidden-terminal-actions">
                <button id="hidden-terminal-cancel" type="button" class="btn btn-secondary">やめておく</button>
                <button id="hidden-terminal-enter" type="button" class="btn btn-primary">覗いてみる</button>
            </div>
        </div>
        <p id="hidden-terminal-description" class="hidden-terminal-description">表示専用のローカルUIです。OSやサーバーのシェルではありません。</p>
        <div id="hidden-terminal-console" class="hidden-terminal-console" hidden>
            <div id="hidden-terminal-output" class="hidden-terminal-output" role="log" aria-label="ターミナルの表示履歴" aria-live="polite" aria-relevant="additions text" tabindex="0"></div>
            <form id="hidden-terminal-form" class="hidden-terminal-form">
                <label for="hidden-terminal-input">netarium:~$</label>
                <input id="hidden-terminal-input" type="text" maxlength="256" aria-label="コマンド（256文字以内）"
                    autocomplete="off" autocapitalize="off" spellcheck="false">
                <button type="submit" class="hidden-terminal-submit" aria-label="コマンドを送信">↵</button>
            </form>
        </div>
    </section>
</div>
