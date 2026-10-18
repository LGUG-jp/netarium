    <main
        id="canvas"
        aria-label="ネットワークトポロジー描画エリア"
    >
        <div id="world">
            <div
                id="canvas-coordinate-guide"
                class="canvas-coordinate-guide"
                aria-hidden="true"
            >
                <div class="canvas-origin-label">
                    0, 0
                </div>

                <div
                    class="
                        canvas-unavailable
                        canvas-unavailable-top
                    "
                >
                    <span>配置不可</span>
                </div>

                <div
                    class="
                        canvas-unavailable
                        canvas-unavailable-left
                    "
                >
                    <span>配置不可</span>
                </div>
            </div>

            <div
                id="floor-plan-layer"
                class="floor-plan-layer"
                aria-hidden="true"
            ></div>

            <svg
                id="link-layer"
                class="link-layer"
                aria-hidden="true"
            ></svg>

            <div id="canvas-note-layer" class="canvas-note-layer"></div>

            <div id="device-layer"></div>

            <!-- 配置モード用ゴーストプレビュー -->
            <div
                id="placement-ghost"
                class="placement-ghost"
                aria-hidden="true"
                hidden
            >
                <div class="placement-ghost-icon-wrap">
                    <img id="placement-ghost-icon" class="placement-ghost-icon" src="" alt="">
                </div>
                <span id="placement-ghost-label" class="placement-ghost-label"></span>
            </div>
        </div>
        <div
            id="canvas-selection-box"
            class="canvas-selection-box"
            aria-hidden="true"
            hidden
        ></div>

    </main>
