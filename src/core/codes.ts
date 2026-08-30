/**
 * The DUInnnn table, explained. Content is distilled from the compiler's own code table
 * (DreamUIDiagnostics.h) -- one entry per cause, the number is the stable part. The whole table
 * lives here, not just the codes this extension raises itself: once compiler diagnostics start
 * arriving (the diagnostics mailbox, batch two), their codes explain themselves for free.
 *
 * When the docs site gets its DUInnnn pages, diagnostics gain a codeDescription URL and this
 * table becomes the offline fallback.
 */

export interface CodeExplanation {
    /** 一句话:这个码在说什么。 */
    title: string;
    /** 为什么会出现。 */
    explain: string;
    /** 怎么修。 */
    fix: string;
}

export const CODE_EXPLANATIONS: Record<number, CodeExplanation> = {
    // --- 1xxx 词法 ---
    1001: {
        title: '一段字符无法构成任何记号',
        explain: '从这里开始的字符不能作为任何记号的开头。实践中最常见的成因是 Source File 指到了一个根本不是 .dui 的文件;连续的非法字符会合并成一条报告。',
        fix: '删掉或改写这段字符;如果整个文件都在报,检查类的 Source File 是否指错了文件。',
    },
    1002: {
        title: '字符串没有闭合引号',
        explain: '字符串不允许跨行——否则一个漏掉的引号会把后面整个文件吞进一个字面量,并在几百行外的位置报错。',
        fix: '在行尾之前补上闭合的 `"`;换行要写成 `\\n`。',
    },
    1003: {
        title: '块注释没有闭合',
        explain: '这个 `/*` 一直到文件结尾都没有等到 `*/`。',
        fix: '补上 `*/`。',
    },
    1004: {
        title: '不是一个数字',
        explain: '两个小数点、悬空的小数点、孤立的负号、残缺的指数(`400e`、`1e+`)或数字后粘着字母(`-3px`)都无法读成数字。设计器写回会使用科学记数法,所以 `1e-45` 是合法拼写。',
        fix: '写成 `-12`、`0.95` 或 `1e-45` 这样的形状;单位不属于这门语言,去掉它。',
    },
    1005: {
        title: '不是一个颜色',
        explain: '`#` 后面要跟 3、4、6 或 8 位十六进制数字(RGB / RGBA / RRGGBB / RRGGBBAA),位数不对或含非十六进制字符都会被拒绝。',
        fix: '改成 `#F00`、`#FF0000` 或 `#FF000080` 这样的拼写。',
    },

    // --- 2xxx 语法 ---
    2001: {
        title: '这里出现了语法不允许的记号',
        explain: '某个位置等到的记号和语法要求的不一致;消息里会同时说明期望什么、来了什么。',
        fix: '按消息提示改写这一行。',
    },
    2002: {
        title: '这个 { 没有等到它的 }',
        explain: '报告落在开括号上,而不是文件末尾——括号才是要去修的地方,"文件结尾有错"是最没用的真话。',
        fix: '在正确的位置补上 `}`。',
    },
    2003: {
        title: '这个 ( 没有等到它的 )',
        explain: '元组的括号没有闭合;`}` 会像文件结尾一样终止搜索,不会吞掉外层节点。',
        fix: '补上 `)`,或检查元组里是否少写了元素。',
    },
    2004: {
        title: '节点缺少 id',
        explain: '每个节点都必须命名——id 会成为生成类的成员变量名。孤立的一个类型名也可能是想写属性却漏了 `=`。',
        fix: '写成 `Text MyName { ... }`;如果这本来是属性,补上 `= 值`。',
    },
    2005: {
        title: '属性缺少值',
        explain: '属性名后面要跟 `=` 或 `<-`,并且操作符后面必须有值。',
        fix: '补上 `= 值` 或 `<- 函数()`。',
    },
    2006: {
        title: '根节点数量不对',
        explain: '一个 .dui 恰好持有一个根节点。第二棵树会在它自己的位置被报告;完全没有根的文件也会被拒绝。',
        fix: '把多余的顶层节点移进根节点里,或拆成另一个 .dui 文件。',
    },
    2007: {
        title: 'class 声明的形状不对',
        explain: '`class` 只出现一次、只出现在文件顶部,并且带一个资产路径。它的职责是给本地化 key 一个稳定的命名空间。',
        fix: '写成 `class /Game/UI/WBP_面板名`,并保证整个文件只有一条。',
    },
    2008: {
        title: '改名子句的形状不对',
        explain: '改名子句只有一种写法:`(was: 旧Id)`。半个 WasId 比没有更糟——编译器会拿它去搬蓝图里的引用,搬到一个作者没写过的名字上等于替人改名。',
        fix: '写成 `(was: OldName)`,内容是单个标识符。',
    },
    2009: {
        title: '@key 覆盖的形状不对',
        explain: '`@key(...)` 的内容必须是单个字符串字面量,它把本地化 key 钉在指定值上。',
        fix: '写成 `@key("旧Id.属性名")`。',
    },
    2010: {
        title: '循环头的形状不对',
        explain: '循环写作 `for 变量 in 函数()` 或 `each 变量 in 函数()`;括号是必须的——它提醒右边是一次调用而不是一个变量。',
        fix: '按 `for Row in GetRows() { ... }` 的形状补全。',
    },

    // --- 3xxx 语义 ---
    3001: {
        title: '两个节点共用一个 id',
        explain: 'id 是节点的身份——guid、成员变量、绑定 key、本地化 key 都由它派生,而且按 FName 语义比较(不区分大小写)。永远不会自动加后缀:替作者改名等于悄悄改判绑定指向谁。',
        fix: '给其中一个换名字;如果是改名,给旧名字写 `(was: 旧Id)`。',
    },
    3002: {
        title: '这个 id 不能用',
        explain: '关键字(class/style/resources/slot/for/each/in/was)不能做 id;以数字开头的名字也不行——SanitizeIdentifier 会给它加前缀下划线,于是 .dui 里写的名字和生成类声明的变量名悄悄分叉,所有绑定都会落空。',
        fix: '换一个以字母或下划线开头、不是关键字的名字;中文名是合法的。',
    },
    3003: {
        title: '未知的节点类型',
        explain: '节点类型要么是内建 tag,要么是能解析的资产路径,这个两者都不是。',
        fix: '检查拼写;嵌套别的 widget 类时写完整资产路径 `/Game/...`。',
    },
    3004: {
        title: '样式没有声明',
        explain: '`: 样式名` 或样式的继承基指向了本文件没有声明的样式。样式只在本文件内解析。',
        fix: '在文件里声明 `style 这个名字 { ... }`,或改成已有的样式名。',
    },
    3005: {
        title: '两个样式共用一个名字',
        explain: '名字按 FName 语义比较(不区分大小写);第二个声明会被丢弃,让第一个继续对所有下游生效。',
        fix: '给第二个样式换个名字,或把两者合并。',
    },
    3006: {
        title: '未知的组件类',
        explain: '`+ 类名` 没有解析到一个具体的 UDreamUIBehaviour 或布局子类。',
        fix: '检查拼写;项目自己的 BP 组件用完整路径,或参考补全列表里编译器实际接受的短名。',
    },
    3008: {
        title: '循环变量遮蔽了外层循环变量',
        explain: '只是警告:今天的语法里没有任何东西能引用循环变量(循环体是重复,不是插值),所以遮蔽被证明不会改变建出来的树。哪天值里能写 `{变量}` 了,这条会升级成错误。',
        fix: '换个变量名,读起来也更清楚。',
    },
    3010: {
        title: '(was:) 指向的旧 id 还活着',
        explain: '作者把节点改了名,又用旧名字建了一个新节点——"把指向旧名字的引用都搬过来"会把引用从一个存在且需要它们的节点上搬走。整个文件的迁移都会被拒绝:半迁移比不迁移更糟。',
        fix: '如果那个同名节点是新建的,先删掉 `(was:)`;如果是笔误,改掉其中一边。',
    },
    3011: {
        title: '两个节点都声称继承同一个旧 id',
        explain: '没有任何依据能决定哪一个继承旧名字的引用。',
        fix: '只保留真正由旧节点改名而来的那一个 `(was:)`。',
    },
    3012: {
        title: '(was:) 指向了节点自己',
        explain: '没有东西可迁移,几乎可以肯定是笔误。',
        fix: '删掉这个 `(was:)`,或改成真正的旧名字。',
    },
    3013: {
        title: '图引用迁移有歧义,跳过了这一腿',
        explain: '蓝图图里的引用按名字解析;旧名字同时还是这个蓝图声明的变量、父类成员或某个函数的局部变量时,全量改写会悄悄改判无关代码。绑定和动画那两腿不受影响,照常迁移。',
        fix: '手工检查图里对旧名字的引用,确认哪些属于这个 widget。',
    },
    3014: {
        title: '资源条目重复',
        explain: '两个 resources 条目共用一个名字(不区分大小写);第一个在所有地方生效,第二个被拒绝。',
        fix: '删掉或改名第二个条目。',
    },
    3015: {
        title: '样式继承成环',
        explain: '顺着继承基走回到了自己,什么都不会被应用。错误报在穿着这个样式的节点上——每个穿了坏样式的节点都会说话。',
        fix: '断开环:检查这条 `style A : B` 链,把其中一环的基改掉或去掉。',
    },

    // --- 4xxx 值 ---
    4001: {
        title: '目标对象上没有这个属性',
        explain: '按名字在目标类上找不到属性;消息会给出最接近的拼写。',
        fix: '按建议改拼写,或对照补全列表确认这个类有哪些属性。',
    },
    4002: {
        title: '点路径中途断了',
        explain: '路径的开头解析成功,但后面某一段不存在。',
        fix: '检查断掉那一段的拼写;用补全逐段展开。',
    },
    4003: {
        title: '值的形状对不上属性类型',
        explain: '这个字面量的形状(数字/字符串/元组/颜色)无法产生该属性的类型。',
        fix: '按属性类型改写值;悬停属性名可以看到期望的类型。',
    },
    4004: {
        title: '元组元素个数不对',
        explain: '目标结构需要的元素个数和写出的不一致,例如 FVector2D 要两个、FMargin 要四个。',
        fix: '按目标结构补齐或删减元素。',
    },
    4005: {
        title: '枚举里没有这个值',
        explain: '写在枚举属性上的标识符不是该枚举声明的值。',
        fix: '用补全从枚举的合法值里选一个。',
    },
    4006: {
        title: '这个属性不能从文本写入',
        explain: '属性存在,但对文本不可写——Transient 且无 setter、editor-only,或被标为 DuiHidden。',
        fix: '这个值由别的属性承载(例如位置由 anchors 承载),改写那个属性。',
    },
    4007: {
        title: '@ 引用没有对应的资源条目',
        explain: '`@名字` 在任何 resources 块里都找不到同名条目(不区分大小写)。',
        fix: '在 resources 块里声明它,或改成已有条目的名字;快速修复可以代劳声明。',
    },
    4008: {
        title: '资源条目的类型和它自己的字面量不符',
        explain: '例如 `Color Accent = 8`——声明说是颜色,字面量却是数字。报在条目行,只报一次。',
        fix: '让类型关键字和字面量一致。',
    },

    // --- 5xxx 建树 ---
    5001: {
        title: '资产加载失败',
        explain: '节点声明的资产路径无法加载——路径错误、资产被删,或者换了机器后绝对路径失效。',
        fix: '核对资产路径;检查资产是否还在。',
    },
    5002: {
        title: '这个节点类型没有承载该属性的 Visual',
        explain: '属性写在了一个该节点类型不会创建的 Visual 上。',
        fix: '确认节点 tag 是否正确,或把属性移到正确的节点上。',
    },
    5003: {
        title: '父级没有可写的 panel slot',
        explain: '`@slot` 属性要求父级的布局产出 panel slot,而这个父级没有。',
        fix: '给父级加上布局组件(如 `+ VerticalBox {}`),或去掉 `@slot` 行。',
    },
    5004: {
        title: '绑定的函数不存在或带参数',
        explain: '`<-` 右边必须是本类声明的无参函数。',
        fix: '在 widget 类上声明这个无参函数,或改成已有的函数名。',
    },
    5005: {
        title: '绑定目标没有 setter',
        explain: '目的属性无法通过 setter 写入,绑定的值送不进去。',
        fix: '换绑到有 setter 的属性,或在 C++ 侧补 setter。',
    },
    5006: {
        title: '嵌套的类不是 UDreamUserWidget 子类',
        explain: '节点 tag 指向的资产存在,但它的类不能作为嵌套 widget。',
        fix: '确认路径指向的是 DreamGUI 的 widget 蓝图。',
    },
    5007: {
        title: '循环体还没有被展开(暂行)',
        explain: '语法从第一天就接受循环,今天写的文件将来都能编译;但展开尚未实现,这条警告告诉你循环体没有进树。此码会在循环落地时退役。',
        fix: '暂时手工展开,或等待循环特性落地。',
    },
    5008: {
        title: '绑定目标的种类无法被记录',
        explain: '绑定结构只认识 Widget / Visual / Behaviour;panel slot、布局容器和带点子路径无处可记——这与"没有 setter"是两回事,修法也不同。',
        fix: '把绑定移到 widget / visual / behaviour 的直接属性上。',
    },
    5009: {
        title: '没有可建的树',
        explain: 'AST 没有携带根节点——语法阶段已经说明了原因,这条只是收尾。',
        fix: '先修复上面的语法错误。',
    },
    5010: {
        title: '事件不存在或不可路由',
        explain: '`->` 左边必须是目标对象上 BlueprintAssignable 的动态多播事件,且不能是带点的子路径。',
        fix: '对照补全列表选择真实的事件名。',
    },

    // --- 6xxx 编译 ---
    6001: {
        title: 'Source File 读不到',
        explain: '类的 Source File 指向的文件不存在或无法读取;报错会列出搜索过的根目录。最常见的成因是文件放在了所有根之外。',
        fix: '把 .dui 放进项目或插件的 DUI/ 目录,或修正路径拼写(裸相对路径会依次搜项目和各插件)。',
    },
    6002: {
        title: '文件解析了,但没有树可编译',
        explain: '.dui 通过了语法阶段,却没有产出可编译的层级。',
        fix: '确认文件里有且只有一个根节点。',
    },
    6003: {
        title: 'class 行和正在编译的蓝图不一致(警告)',
        explain: 'class 行的职责是给本地化 key 一个稳定命名空间——写错漂移的是 key,不是构建。native 父类跨子类共享文件时,谁都不匹配是合法状态,所以这是警告不是错误。',
        fix: '把 class 行改成本蓝图的路径;共享文件的场景可以忽略。',
    },

    // --- 7xxx 写回 ---
    7001: {
        title: '写回找不到落点',
        explain: 'patcher 被要求写一个在文本里找不到归宿的属性。',
        fix: '检查文件是否被外部改动过;必要时重新编译让两侧对齐。',
    },
    7002: {
        title: '文件在编辑期间被外部改动',
        explain: '磁盘上的 .dui 在一次未落盘的编辑下面变了,写回被拒绝以免盖掉外部修改。',
        fix: '重新加载文件,再重做这次编辑。',
    },
    7003: {
        title: '这个值没有文本拼写',
        explain: '非有限浮点(inf/NaN)印出来的样子无法被词法读回——设计器若写出这样一行,文件重开就编不过,而且坏的是没人碰过的行。所以在写回时就拒绝,把损坏留在作者看得见的地方。',
        fix: '检查是什么把属性推到了非有限值(除零、未初始化),修好后再写回。',
    },
};

/** Markdown for one code, or undefined when the number is not in the table. */
export function explainCode(code: number): string | undefined {
    const entry = CODE_EXPLANATIONS[code];
    if (!entry) {
        return undefined;
    }
    return `# DUI${code} · ${entry.title}\n\n${entry.explain}\n\n**怎么修**:${entry.fix}\n\n---\n\n`
        + `*码表与编译器 \`DreamUIDiagnostics.h\` 同源;数字是稳定部分,文案会持续改进。*\n`;
}
