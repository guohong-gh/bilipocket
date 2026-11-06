// 演示入口专用 DOM 片段：仅由 dev 服务器注入，不进入安装包。
export const fragments = {
  "dev-slot:samples": `<div class="sample-group">
                      <span>试试示例</span>
                      <button class="sample-chip" type="button" data-sample="sunset">落日短片</button>
                      <button class="sample-chip" type="button" data-sample="night">城市夜行</button>
                      <button class="sample-chip" type="button" data-sample="forest">山野来信</button>
                      <button class="sample-chip" type="button" data-sample="cafe">雨天便利店</button>
                    </div>`,

  "dev-slot:account": `<div class="setting-row setting-row-inline setting-row-wrap">
                    <div class="setting-label">
                      <strong>演示账号状态</strong>
                      <span>仅本地演示，不登录、不联网；只改变哪些清晰度显示为可用。</span>
                    </div>
                    <div class="segmented" id="account-tier" role="radiogroup" aria-label="演示账号状态">
                      <button type="button" data-account-tier="guest" role="radio" aria-checked="true" tabindex="0">未登录</button>
                      <button type="button" data-account-tier="member" role="radio" aria-checked="false" tabindex="-1">已登录</button>
                      <button type="button" data-account-tier="vip" role="radio" aria-checked="false" tabindex="-1">大会员</button>
                    </div>
                  </div>`,

  "dev-slot:reset": `<button class="btn btn-ghost btn-sm" type="button" id="reset-demo">
                        <svg class="icon" aria-hidden="true"><use href="#i-refresh"></use></svg>
                        重置演示数据
                      </button>`,
};
