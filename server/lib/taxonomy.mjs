/**
 * 安全巡检视频处理 · 隐患检查表（Taxonomy / Checklist）
 * ------------------------------------------------------------------
 * 设计原则：检测闭集化。安全隐患是封闭清单，不是开放式描述。
 * 每一项检查项都带：规范依据、等级映射、反证模板、盲区模板。
 * 生产环境中，本文件应由「项目级检查表配置」在后台可视化维护并落库。
 */

export const CATEGORIES = [
  {
    code: 'PPE_HARDHAT',
    name: '人员未佩戴安全帽',
    group: '个体防护',
    color: '#e2483c',
    defaultSeverity: '一般',
    basis: [{ code: 'JGJ 59-2011', clause: '3.1.3', text: '施工现场人员应正确佩戴安全帽。' }],
    counterEvidenceTemplate: '画面中人员头部被构件、equipment 或前景反光背心遮挡，无法确认是否佩戴；需换角度帧确认。',
    blindSpotTemplate: '第一视角平视拍摄，仅覆盖镜头朝向区域的人员，画面外人员不在判定范围。',
    measure: '现场提醒并补发安全帽，班组班前教育留痕。'
  },
  {
    code: 'OPENING_EDGE',
    name: '楼板洞口/临边未见盖板或防护',
    group: '临边洞口防护',
    color: '#d97706',
    defaultSeverity: '较大',
    basis: [
      { code: 'JGJ 80-2016', clause: '4.1.2', text: '洞口应根据情况采取防护栏杆、加盖板、张挂安全网与防护棚等措施。' },
      { code: 'JGJ 80-2016', clause: '4.2.1', text: '临边作业应设置防护栏杆并挂设安全网。' }
    ],
    counterEvidenceTemplate: '洞口边缘存在高光反射，可能为已覆盖的钢盖板或临时硬质覆盖物，需现场核对。',
    blindSpotTemplate: '镜头为平视视角，无法俯视洞口正下方，无法判断洞口是否有底部兜网。',
    measure: '按规范设置硬质盖板并固定，或设置防护栏杆+密目网，验收后挂设警示标识。'
  },
  {
    code: 'TEMP_POWER',
    name: '临时用电线路敷设不规范',
    group: '临时用电',
    color: '#c2410c',
    defaultSeverity: '一般',
    basis: [{ code: 'JGJ 46-2005', clause: '7.2.3', text: '电缆线路应采用埋地或架空敷设，严禁沿地面明设。' }],
    counterEvidenceTemplate: '该线路可能为短时作业临时线且已设专人看护，需确认敷设时段与看护记录。',
    blindSpotTemplate: '画面未覆盖线路起点配电箱，无法判断是否具备漏电保护与接零保护。',
    measure: '改为架空或穿管保护敷设，过道处设置过线槽或防护盖板。'
  },
  {
    code: 'MATERIAL_STACK',
    name: '材料堆放不规范',
    group: '文明施工',
    color: '#2563eb',
    defaultSeverity: '一般',
    basis: [{ code: 'JGJ 59-2011', clause: '3.9.3', text: '材料应分类堆放整齐、稳固，并设置标识牌。' }],
    counterEvidenceTemplate: '该区域可能处于材料转运作业中，短时堆放属正常工序状态。',
    blindSpotTemplate: '镜头未覆盖堆料区域全貌，无法判断堆高是否超过规范限值。',
    measure: '分类码放、限高设置、挂标识牌，转运通道保持畅通。'
  },
  {
    code: 'EDGE_SURCHARGE',
    name: '临边区域堆载、材料贴近防护栏杆',
    group: '临边洞口防护',
    color: '#b91c1c',
    defaultSeverity: '较大',
    basis: [{ code: 'JGJ 80-2016', clause: '4.2.5', text: '临边防护栏杆内侧不得堆放材料、构件等物料。' }],
    counterEvidenceTemplate: '材料与栏杆之间可能存在未被镜头捕捉的安全距离，需现场实测该距离。',
    blindSpotTemplate: '无法通过画面判断栏杆内侧净距，也无法判断栏杆是否焊接固定于结构。',
    measure: '清运临边材料，栏杆内侧留出不小于规范要求的安全距离，设置禁止堆载标识。'
  },
  {
    code: 'MOBILE_SCAFFOLD',
    name: '移动式脚手架作业',
    group: '脚手架',
    color: '#7c3aed',
    defaultSeverity: '较大',
    basis: [
      { code: 'JGJ 80-2016', clause: '5.2.3', text: '移动式操作平台应设置防护栏杆并锁住脚轮。' },
      { code: 'JGJ 80-2016', clause: '5.2.4', text: '操作平台上作业人员应系挂安全带。' }
    ],
    counterEvidenceTemplate: '作业人员可能已在平台另一侧系挂安全带，当前角度看不到安全带挂点。',
    blindSpotTemplate: '镜头仰角不足，无法看到作业人员腰部以下及平台底板，无法判断脚轮是否锁定、是否设置抛撑。',
    measure: '锁定脚轮、设置抛撑与防护栏杆，作业人员系挂安全带，禁止超载与移动中作业。'
  },
  {
    code: 'SLIP_FALL',
    name: '湿滑地面/积水滑跌风险',
    group: '文明施工',
    color: '#0891b2',
    defaultSeverity: '提示',
    basis: [{ code: 'JGJ 59-2011', clause: '3.9.2', text: '施工现场应保持道路畅通、场地平整、排水通畅。' }],
    counterEvidenceTemplate: '地面湿润可能为洒水降尘作业后的正常状态。',
    blindSpotTemplate: '画面无法反映地面摩擦系数与排水坡度，属提示性风险。',
    measure: '加强排水、及时清理积水，坡道与楼梯设置防滑措施。'
  },
  {
    code: 'FIRE_EQUIP',
    name: '消防器材配置状态',
    group: '消防',
    color: '#059669',
    defaultSeverity: '提示',
    // 该检查项产出的是「正向记录」而非隐患，不参与隐患计数与整改单。
    // 统一口径见下方 isRiskCategory()。
    positive: true,
    basis: [{ code: 'JGJ 59-2011', clause: '3.11.3', text: '施工现场应按规定配置消防器材，并定期检查。' }],
    counterEvidenceTemplate: '器材可能已在其他位置配置，需核对消防平面布置图。',
    blindSpotTemplate: '画面无法读取灭火器压力表与检验日期，无法判断是否失效。',
    measure: '按平面布置图核对数量与位置，检查压力表与巡检记录卡。'
  },
  {
    code: 'SAFE_PRACTICE',
    name: '防护到位（正向记录）',
    group: '正向记录',
    color: '#0e9f6e',
    defaultSeverity: '提示',
    basis: [{ code: 'JGJ 80-2016', clause: '4.2.1', text: '临边作业应设置防护栏杆并挂设安全网。' }],
    counterEvidenceTemplate: '不适用。',
    blindSpotTemplate: '仅记录画面可见范围，不代表未拍到区域同样合规。',
    measure: '保持现状。'
  }
];

export const CATEGORY_BY_CODE = Object.fromEntries(CATEGORIES.map((c) => [c.code, c]));
export const CATEGORY_BY_NAME = Object.fromEntries(CATEGORIES.map((c) => [c.name, c]));

/**
 * 唯一口径：判断某个检查项是否属于「安全隐患」。
 * ---------------------------------------------------------------
 * 背景：正向记录（防护到位、消防器材合规）不应计入隐患数量，
 * 也不应出现在整改通知单里。此前各处分别写 `!== 'SAFE_PRACTICE'`，
 * 口径不一，导致总结说"7 项隐患"、记录表却列出 8 行的矛盾。
 * 现在所有统计与文书生成都必须调用本函数。
 */
export function isRiskCategory(code) {
  const c = CATEGORY_BY_CODE[code];
  if (!c) return true;
  return !c.positive && c.code !== 'SAFE_PRACTICE';
}

/** 正向记录类检查项（用于"防护到位情况"分区） */
export function isPositiveCategory(code) {
  return !isRiskCategory(code);
}

/** 隐患等级：用于排序与报告分级 */
export const SEVERITY_ORDER = { 重大: 0, 较大: 1, 一般: 2, 提示: 3 };

/** 自然语言检索的同义词表：用于把口语查询映射到检查项 */
export const SYNONYMS = {
  PPE_HARDHAT: ['安全帽', '安全头盔', '未戴', '没戴', '未佩戴', '不戴', '帽', 'helmet', 'ppe', '个体防护', '劳保'],
  OPENING_EDGE: ['洞口', '楼板洞口', '预留洞', '井道', '盖板', '盖', '栏杆', '防护栏杆', '临边', '无防护', '未见覆盖', '防护网'],
  EDGE_SURCHARGE: ['临边堆放', '堆载', '超载', '贴边', '靠边', '栏杆内侧', '材料贴边'],
  TEMP_POWER: ['电缆', '电线', '线路', '拖地', '明设', '敷设', '配电', '用电', '触电', '裸线', '线缆'],
  MATERIAL_STACK: ['材料堆放', '堆料', '码放', '堆放', '乱堆', '钢管', '扣件', '模板', '木方', '跳板', '分类'],
  MOBILE_SCAFFOLD: ['脚手架', '移动架', '门式', '操作平台', '高坠', '高挂', '安全带', '攀爬', '架子'],
  SLIP_FALL: ['积水', '湿滑', '滑倒', '滑跌', '地面', '排水', '楼梯'],
  FIRE_EQUIP: ['消防', '灭火器', '消防器材', '防火', '动火'],
  SAFE_PRACTICE: ['到位', '合规', '规范', '好', '合格', '正确']
};

/** 固定时长片段：检索结果以 3 秒片段为单位 */
export const CLIP_SECONDS = 3;
