# 鲸鱼娘素材与视觉说明

本版使用内置 imagegen 工具生成六张带真实透明通道的 PNG 插画。没有调用 CLI，也不需要在应用中配置图片 API。

## 在线设计参考

- [LINUX DO：一只蓝色大肥鱼](https://linux.do/t/topic/2878430)：蓝发、鲸鳍、鲸尾、深蓝白女仆装、圆脸鼓腮的 Q 版形象。
- [游民星空：DeepSeek 娘“蓝色肥鱼版”二创](https://www.gamersky.com/news/202608/2190273.shtml)：用于核对用户所指的形象类型。
- [参考角色原图](https://raw.githubusercontent.com/tokenhunter475/awesome-chatgpt-plus-guide/main/assets/articles/2026-09-20-deepseek-pet/deepseek-base.png)：仅作为造型参考，不直接用于运行时。

开发时下载的参考图保存在本地 `docs/references/`，不随仓库分发。运行时使用的六张新图在 `src/renderer/assets/girl-{idle,focus,happy,angry,slash,dnd}.png`。旧鲸鱼 SVG 不再被界面引用。

## 生成提示词

基础图（idle），内置工具，`transparent_background: true`，输入两张在线参考：

> Use case: stylized-concept. Create a production transparent-background desktop pet sprite of the DeepSeek whale girl shown in the two reference images. They are design references, NOT edit targets. Single full body character, centered with generous 8% transparent margins and feet at 92% image height. Cute anime chibi, 2.5 heads tall, large round fair face, deep navy/cornflower blue long wavy hair, curved whale ahoge, fin-shaped ears, large expressive blue eyes, pink blush, visible large blue whale tail to her right, navy and white frilled full-coverage maid dress, frilled white maid headband, white apron with tiny blue whale emblem, little navy shoes and white stockings. Match the first reference's cute chubby-cheeked hungry 'blue fat fish' personality and dark blue palette; refined anime cel shading and clean expressive linework, no 3D, no simplified vector geometry. State: IDLE, warm smug tiny cat-mouth smile, hands resting together near apron, upright slightly tilted head. The sprite must contain ONLY the character, no rice bowl, no other people, no words, no speech bubble, no watermark, no colored background, no magenta or checkerboard painted into the image. Genuine RGBA transparent background. High-quality illustrated game sprite readable at 176 px.

其余五张以生成的 idle PNG 为唯一输入，内置工具，`transparent_background: true`。公共提示词：

> Use case: identity-preserve. Edit the reference desktop-pet sprite into its {STATE} state. Lock the exact same character identity, cute round face, detailed dark blue long hair and whale-fin ears, ahoge, blue eyes, maid headband, navy-white frilly full-coverage maid dress with tiny whale apron emblem, white stockings, blue shoes and large whale tail, exact anime cel shading and line art, identical full-body scale, identical canvas and transparent margins, same front-three-quarter camera. Change only the expression and pose as follows: {POSE} Single full-body character with full ahoge and feet visible, centered. Real RGBA transparent background. No words, no borders, no background, no checkerboard painted in. Production game sprite.

对应的 STATE / POSE：

- FOCUS: Focused studying expression, eyes lowered toward a small open cream-colored book held in front of her apron with both hands, small round navy spectacles. No other props.
- HAPPY: Very happy celebration, both eyes closed in cute upturned curves, small open happy mouth, one arm lifted in a little fist-pump and one hand at her chest, tail slightly lifted. No confetti or floating symbols, ONLY the character.
- ANGRY: Adorably irritated pout, puffed round cheeks, eyebrows lowered, hands on hips, feet planted. Cute and determined, not scary. No floating anger symbols or punctuation.
- SLASH: Cute determined ready-to-swing pose, feet apart, body turned slightly toward viewer's left, BOTH hands clasped together at chest height on the viewer-left side of the body as if gripping a sword handle. Hands near x=37% y=50% of character bounding box. NO weapon, no blade, no staff, no hilt: an enormous separate weapon will be attached in code. Preserve all hair, dress, tail and full body in the same frame.
- DND: Sleepy expression with both eyes gently closed, a small peaceful smile, hugging a little light-blue pillow in front of her apron with both hands. Standing upright, not lying down, keep same scale and silhouette. No floating Z letters.

## 特效实现

裂屏由 `glass-fracture.js` 创建径向断口、分叉、横向断口、撞击点微碎屑和低透明度玻璃反光。暗缝与白色断面使用同一套几何数据，不发蓝光。场景没有文字、人物、漫画装饰或背景色；真实桌面透过覆盖层显示。不读取或截图用户桌面。

砍刀由 `giant-cleaver.svg` 单独绘制，260vmax 长。`pet-performance.js` 操作原本宠物窗口中的同一个角色节点，测量双手和拳头位置，将屏幕坐标实时传给覆盖层。刀柄跟随双手，裂纹从拳头位置产生；覆盖层不包含角色图片或提醒海报。钢刃带刀背、单面刀锋、金属明暗和磨痕。角色蓄力、挥下、回收，刀身大部分超出屏幕，形成四十米砍刀的反差。关怀由本体走位、挥手和小气泡完成。

桌面背景是 `scripts/preview-desktop.css` 和测试脚本构造的虚拟工作台，不包含用户桌面内容。`npm run verify` 最后的本体联动验收会将真实宠物窗口和透明特效层的截图合成到虚拟工作台上，输出自然桌面、砍刀、裂屏和关怀预览。透明原图额外导出为 `docs/previews/effect-crack-transparent.png`。
