    <div
        id="view-manager-overlay"
        class="view-manager-overlay"
        hidden
    >
        <section
            class="view-manager-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="view-manager-title"
        >
            <header class="view-manager-header">
                <div>
                    <h2 id="view-manager-title">
                        ビュー管理
                    </h2>

                    <p>
                        論理構成図・フロア配置図・ラック搭載図を管理します。
                    </p>
                </div>

                <button
                    type="button"
                    class="modal-close-btn"
                    aria-label="閉じる"
                    id="close-view-manager-btn"
                >
                    ×
                </button>
            </header>

            <div class="view-manager-toolbar">
                <div class="view-create-buttons" role="group" aria-label="ビューを新規登録">
                    <button id="view-add-topology-btn" type="button" class="btn btn-primary btn-sm">＋ 論理構成図</button>
                    <button id="view-add-floor-btn" type="button" class="btn btn-primary btn-sm">＋ フロア図</button>
                    <button id="view-add-rack-btn" type="button" class="btn btn-primary btn-sm">＋ ラック図</button>
                </div>
                <div class="view-create-compact">
                    <label for="vm-new-type">登録する種別</label>
                    <select id="vm-new-type">
                        <option value="topology">論理・全体構成図</option>
                        <option value="floor">物理・フロア配置図</option>
                        <option value="rack">ラック搭載図</option>
                    </select>
                    <button
                        id="view-add-btn"
                        type="button"
                        class="btn btn-primary btn-sm"
                    >
                        ビューを登録
                    </button>
                </div>

                <button
                    id="view-duplicate-btn"
                    type="button"
                    class="btn btn-secondary btn-sm"
                >
                    複製
                </button>

                <button
                    id="view-delete-btn"
                    type="button"
                    class="btn btn-danger btn-secondary btn-sm"
                >
                    削除
                </button>

                <span id="view-manager-count">
                    0 / 100件
                </span>
            </div>

            <div class="view-manager-body">
                <aside class="view-manager-list-area">
                    <label for="view-manager-search">
                        ビュー検索
                    </label>

                    <input
                        id="view-manager-search"
                        type="search"
                        placeholder="名称、施設、フロアで検索"
                    >

                    <div
                        id="view-manager-list"
                        class="view-manager-list"
                        role="listbox"
                        aria-label="ビュー一覧"
                    ></div>
                </aside>

                <form
                    id="view-manager-form"
                    class="view-manager-form"
                >
                    <input
                        id="vm-id"
                        type="hidden"
                    >

                    <label for="vm-name">
                        ビュー名
                        <span class="required">*</span>
                    </label>

                    <input
                        id="vm-name"
                        type="text"
                        data-max-length="100"
                        required
                    >
                    <p id="vm-name-error" class="form-error" aria-live="polite" hidden></p>

                    <label for="vm-facility">
                        施設
                    </label>

                    <input
                        id="vm-facility"
                        type="text"
                        data-max-length="100"
                    >
                    <p id="vm-facility-error" class="form-error" aria-live="polite" hidden></p>

                    <label for="vm-floor">
                        フロア
                    </label>

                    <input
                        id="vm-floor"
                        type="text"
                        data-max-length="50"
                    >
                    <p id="vm-floor-error" class="form-error" aria-live="polite" hidden></p>

                    <label for="vm-type">
                        種別
                    </label>

                    <select id="vm-type">
                        <option value="topology">
                            論理・全体構成図
                        </option>
                        <option value="floor">
                            物理・フロア配置図
                        </option>
                        <option value="rack">ラック搭載図</option>
                    </select>
                    <p id="vm-type-error" class="form-error" aria-live="polite" hidden></p>
                    <p class="form-support">既存ビューとラックの種別は相互に変更できません。</p>

                    <fieldset id="vm-rack-fields" hidden>
                        <legend>ラック設定</legend>
                        <label for="vm-total-u">総U数</label>
                        <input id="vm-total-u" type="number" min="1" max="60" step="1">
                        <p id="vm-total-u-error" class="form-error" aria-live="polite" hidden></p>
                        <label for="vm-location">設置場所（任意）</label>
                        <input id="vm-location" type="text" data-max-length="150">
                        <p id="vm-location-error" class="form-error" aria-live="polite" hidden></p>
                        <p>総U数は1〜60Uです。搭載機器の範囲を切り捨てる縮小はできません。</p>
                    </fieldset>

                    <div class="view-manager-floor-plan-actions">
                        <button
                            id="vm-floor-plan-btn"
                            type="button"
                            class="btn btn-secondary btn-sm"
                            aria-describedby="vm-floor-plan-help"
                            disabled
                        >
                            フロア図面
                        </button>
                        <span id="vm-floor-plan-help" aria-live="polite">
                            種別に「物理・フロア配置図」を選択してください。
                        </span>
                    </div>

                    <label for="vm-sort-order">
                        表示順
                    </label>

                    <input
                        id="vm-sort-order"
                        type="number"
                        min="-999999"
                        max="999999"
                        step="1"
                    >
                    <p id="vm-sort-order-error" class="form-error" aria-live="polite" hidden></p>

                    <label for="vm-memo">
                        備考
                    </label>

                    <textarea
                        id="vm-memo"
                        data-max-length="1000"
                        rows="3"
                    ></textarea>
                    <div id="vm-memo-count" class="character-counter" aria-live="polite">0/1000</div>
                    <p id="vm-memo-error" class="form-error" aria-live="polite" hidden></p>

                    <div class="view-manager-form-actions">
                        <button
                            id="view-conflict-reload-btn"
                            type="button"
                            class="btn btn-secondary btn-sm"
                            hidden
                        >
                            このビューを再読込
                        </button>
                        <button
                            id="view-apply-btn"
                            type="button"
                            class="btn btn-primary btn-sm"
                            title="入力を適用し、自動保存します"
                        >
                            適用
                        </button>
                    </div>
                </form>
            </div>

            <footer class="view-manager-footer">
                <p>
                    入力は「適用」で確定します。登録・複製・削除は直ちに自動保存され、閉じても取り消されません。
                </p>
            </footer>
        </section>
    </div>
