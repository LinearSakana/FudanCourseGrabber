// ==UserScript==
// @name         复旦抢课助手 (2025.12)
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  简易的 Tampermonkey 脚本，用于复旦大学本科生抢课；支持并发，验证码识别，批量导入
// @author       Gemini & Deepseek & github.com/LinearSakana
// @match        *://xk.fudan.edu.cn/*
// @icon         https://id.fudan.edu.cn/ac/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      self
// @connect      docs.opencv.org
// @connect      cdn-fudan.demo.supwisdom.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- 全局配置 ---
    const ENABLE_RPS_CALCULATING = true;  // 手动设置，决定是否统计 RPS，
    const NEGLECT_CAPTCHA_VERIFICATION_RESPONSE = true;  // 手动设置，决定验证码循环时是否 await 响应结果
    const STATE = {
        courses: [], // 意向课程列表 { lessonAssoc: number, status: 'pending' | 'success' }
        studentId: '',
        turnId: '',
        headers: {}, // 从原始请求中捕获的全局 HTTP 头
        isGrabbing: false,
        skipCaptcha: false, // 是否跳过验证码
        useLocalLUT: true,  // 是否使用本地 LUT
        isImporting: false,
        concurrency: 2, // 每门课并发实例数量
        activeWorkers: new Map(), // 存储活跃的 Worker 实例，键为唯一 ID ，值为 Worker 对象
        isCaptchaLoopRunning: false,

        // 统计 RPS
        reqTimestamps: [], // 存储每个请求完成的时间戳
        rps: 0,
        rpsIntervalId: null, // setInterval 的 ID
    };
    // 验证码的 imgIndex 只有下面六种可能
    const LIST_OF_IMGINDEX = [
        "3ab5eec0-fbb6-4c3f-bfcc-0ce693077db3",
        "393c5000-304d-4d2d-9ce1-3db6345e0a6b",
        "3437e4cb-a995-4fae-aeea-14174abc0d6a",
        "60176ec4-7482-4763-876a-431eceefe779",
        "c6e7c8e9-b681-4dc2-8d61-e45588f8c7fa",
        "c9f5d967-9c4b-43fe-b2eb-dc0a2ef01ed7"
    ];

    // --- Web Worker 代码 ---
    const workerCode = `
        let studentId, turnId, lessonAssoc, headers;

        // 日志函数，向主线程发送日志
        const log = (message) => postMessage({ type: 'log', message: \`[课程\${lessonAssoc}]: \${message}\` });

        /**
         * 通过主线程代理 GM_xmlhttpRequest 网络请求
         * @param {object} details - GM_xmlhttpRequest 的请求参数
         * @returns {Promise<object>} 包含响应内容的Promise
         */
        function request(details) {
            return new Promise((resolve, reject) => {
                const requestId = Math.random().toString(36).substring(7);
                const listener = (event) => {
                    if (event.data.type === 'request_response' && event.data.requestId === requestId) {
                        self.removeEventListener('message', listener);
                        event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.response);
                    }
                };
                self.addEventListener('message', listener);
                const finalHeaders = { ...headers, ...(details.headers || {}) };
                postMessage({ type: 'gm_request', requestId, details: { ...details, headers: finalHeaders } });
            });
        }

        /**
         * 核心抢课循环函数
         */
        async function grabCourse() {
            while (true) { 
                try {
                    // log('开始新一轮抢课尝试...');
                    
                    // log('发送预选请求: ');
                    const predicateUrl = '/api/v1/student/course-select/add-predicate';
                    const predicatePayload = {
                        studentAssoc: parseInt(studentId, 10),
                        courseSelectTurnAssoc: parseInt(turnId, 10),
                        requestMiddleDtos: [{ lessonAssoc: lessonAssoc, virtualCost: 0 }],
                        coursePackAssoc: null
                    };
                    const predicateRes = await request({
                        method: 'POST',
                        url: predicateUrl,
                        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
                        data: JSON.stringify(predicatePayload)
                    });
                    const predicateParsed = JSON.parse(predicateRes.responseText);
                    if (predicateParsed.result !== 0 || !predicateParsed.data) continue;
                    const predicateData = predicateParsed.data;
                    log(\`预选成功, Predicate: \${predicateData}\`);

                    const predicateResUrl = \`/api/v1/student/course-select/predicate-response/\${studentId}/\${predicateData}\`;
                    request({ method: 'GET', url: predicateResUrl }); // 忽略 request 返回值，提升循环效率

                    // 发送最终添加请求 (add-request) 
                    const addReqUrl = '/api/v1/student/course-select/add-request';
                    const addReqPayload = {
                        studentAssoc: parseInt(studentId, 10),
                        courseSelectTurnAssoc: parseInt(turnId, 10),
                        requestMiddleDtos: [{ lessonAssoc: lessonAssoc, virtualCost: null }],
                        coursePackAssoc: null
                    };
                    const addReqRes = await request({
                        method: 'POST',
                        url: addReqUrl,
                        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
                        data: JSON.stringify(addReqPayload)
                    });
                    const addReqParsed = JSON.parse(addReqRes.responseText);
                    if (addReqParsed.result !== 0 || !addReqParsed.data) continue;
                    const addReqData = addReqParsed.data;

                    const addDropUrl = \`/api/v1/student/course-select/add-drop-response/\${studentId}/\${addReqData}\`;
                    const addDropRes = await request({ method: 'GET', url: addDropUrl });
                    const addDropParsed = JSON.parse(addDropRes.responseText);

                    if (addDropParsed.data && addDropParsed.data.success) {
                        postMessage({ type: 'success', lessonAssoc: lessonAssoc });
                        self.close();
                        return; // 退出循环
                    } else {
                        throw new Error(\`最终确认失败: \${addDropParsed.message || '未知错误'}\`);
                    }
                } catch (error) {
                    log(\`错误: \${error.message}\`);
                }
            }
        }

        // 监听主线程消息
        self.onmessage = function(event) {
            const { type, data } = event.data;
            if (type === 'start') {
                studentId = data.studentId;
                turnId = data.turnId;
                lessonAssoc = data.lessonAssoc;
                headers = data.headers;
                grabCourse();
            } else if (type === 'stop') {
                // log('Worker已被主线程终止 ');
                self.close();
            }
        };
    `;


    // --- UI 模块 ---
    const UI = {
        panel: null,
        courseListEl: null,
        createPanel() {
            if (document.getElementById('grabber-panel')) return;
            const panel = document.createElement('div');
            panel.id = 'grabber-panel';
            panel.innerHTML = `
                <div class="grabber-header">抢课助手</div>
                <div class="grabber-body">
                    <div class="grabber-input-group">
                        <label for="student-id-input">StudentID:</label>
                        <input type="text" id="student-id-input" placeholder="自动捕获..." readonly>
                    </div>
                    <div class="grabber-input-group">
                        <input type="checkbox" id="skip-captcha-checkbox">
                        <label for="skip-captcha-checkbox">跳过验证</label>
                        <input type="checkbox" id="use-local-lut-checkbox">
                        <label for="use-local-lut-checkbox">导入本地 Captcha</br>查找表（.json）</label>
                    </div>
                    <div class="grabber-slider-group">
                        <label for="concurrency-slider" id="concurrency-num">并发数:</label>
                        <input type="range" id="concurrency-slider" min="1" max="10" value="5">
                        <span id="concurrency-value">5</span>                       
                        <span>RPS:</span>
                        <span id="rps-value">0</span>                        
                    </div>
                    <h3>意向课程列表</h3>
                    <ul id="course-list"></ul>
                    <div class="grabber-sub-actions">
                        <button id="import-btn">导入页面</button>
                        <button id="reset-btn">重置上下文</button>
                        <button id="clear-btn">清空列表</button>
                    </div>
                    <div class="grabber-actions">
                        <button id="grab-btn">开始抢课</button>
                    </div>
                </div>
            `;
            document.body.appendChild(panel);
            this.panel = panel;
            this.courseListEl = document.getElementById('course-list');
            this.applyStyles();
            this.makeDraggable(panel, panel.querySelector('.grabber-header'));
            this.addEventListeners();
        },
        applyStyles() {
            const styles = `
                #grabber-panel { position: fixed; top: 100px; right: 20px; width: 300px; background: #f9f9f9; border: 1px solid #ccc; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); z-index: 9999; font-family: sans-serif; font-size: 14px; }
                .grabber-header { padding: 10px; background: #4a90e2; color: white; font-weight: bold; cursor: move; border-top-left-radius: 8px; border-top-right-radius: 8px; }
                .grabber-body { padding: 15px; }
                .grabber-input-group, .grabber-slider-group { margin-bottom: 15px; display: flex; align-items: center; }
                .grabber-input-group label, .grabber-slider-group label { margin-right: 10px; cursor: pointer; }
                #concurrency-num { margin-right: 6px; }
                #student-id-input { flex-grow: 1; padding: 5px; border: 1px solid #ccc; border-radius: 4px; background: #eee; }
                #concurrency-slider { flex-grow: 1; }
                #concurrency-value { min-width: 20px; text-align: center; font-weight: bold; }
                #rps-value { font-weight: bold; color: #007bff; margin-left: 5px; }
                h3 { margin: 10px 0; font-size: 16px; border-bottom: 1px solid #eee; padding-bottom: 5px; }
                #course-list { list-style: none; padding: 0; margin: 0; max-height: 200px; overflow-y: auto; }
                #course-list li { display: flex; align-items: center; padding: 8px 5px; border-bottom: 1px solid #eee; }
                #course-list li:last-child { border-bottom: none; }
                .course-id { flex-grow: 1; }
                .course-status { font-weight: bold; margin-right: 10px; }
                .status-pending { color: #f39c12; }
                .status-success { color: #2ecc71; }
                .course-actions button { background: none; border: none; cursor: pointer; font-size: 16px; }
                .grabber-sub-actions { display: flex; justify-content: space-between; margin-top: 10px; margin-bottom: 15px; }
                .grabber-sub-actions button { padding: 5px 10px; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; background: #fff; }
                .grabber-actions { margin-top: 15px; text-align: center; }
                #grab-btn { width: 100%; padding: 10px; font-size: 16px; background-color: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; transition: background-color 0.3s; }
                #grab-btn.grabbing { background-color: #f44336; }
                button:disabled { cursor: not-allowed; opacity: 0.6; }
            `;
            const styleSheet = document.createElement("style");
            styleSheet.type = "text/css";
            styleSheet.innerText = styles;
            document.head.appendChild(styleSheet);
        },
        makeDraggable(element, handle) {
            let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
            handle.onmousedown = (e) => {
                e.preventDefault();
                pos3 = e.clientX;
                pos4 = e.clientY;
                document.onmouseup = () => {
                    document.onmouseup = null;
                    document.onmousemove = null;
                };
                document.onmousemove = (e) => {
                    e.preventDefault();
                    pos1 = pos3 - e.clientX;
                    pos2 = pos4 - e.clientY;
                    pos3 = e.clientX;
                    pos4 = e.clientY;
                    element.style.top = (element.offsetTop - pos2) + "px";
                    element.style.left = (element.offsetLeft - pos1) + "px";
                };
            };
        },
        render() {
            document.getElementById('student-id-input').value = STATE.studentId;
            document.getElementById('skip-captcha-checkbox').checked = STATE.skipCaptcha;
            document.getElementById('use-local-lut-checkbox').checked = STATE.useLocalLUT;
            document.getElementById('concurrency-slider').value = STATE.concurrency;
            document.getElementById('concurrency-value').textContent = STATE.concurrency;
            document.getElementById('rps-value').textContent = ENABLE_RPS_CALCULATING ? STATE.rps : '禁用';

            this.courseListEl.innerHTML = '';
            STATE.courses.forEach((course, index) => {
                const li = document.createElement('li');
                const statusClass = course.status === 'success' ? 'status-success' : 'status-pending';
                const statusText = course.status === 'success' ? '成功' : (STATE.isGrabbing ? '抢课中...' : '待抢');
                li.innerHTML = `
                    <span class="course-id">LessonAssoc: ${course.lessonAssoc}</span>
                    <span class="course-status ${statusClass}">${statusText}</span>
                    <div class="course-actions">
                        <button data-index="${index}" data-action="delete" title="删除">❌</button>
                    </div>
                `;
                this.courseListEl.appendChild(li);
            });

            const grabBtn = document.getElementById('grab-btn');
            const importBtn = document.getElementById('import-btn');
            const resetBtn = document.getElementById('reset-btn');
            const clearBtn = document.getElementById('clear-btn');

            if (STATE.isGrabbing) {
                grabBtn.textContent = '停止抢课';
                grabBtn.classList.add('grabbing');
                importBtn.disabled = true;
                resetBtn.disabled = true;
                clearBtn.disabled = true;
            } else {
                grabBtn.textContent = '开始抢课';
                grabBtn.classList.remove('grabbing');
                importBtn.disabled = false;
                resetBtn.disabled = false;
                clearBtn.disabled = false;
            }

            importBtn.textContent = STATE.isImporting ? '正在导入...' : '导入页面';
            importBtn.disabled = STATE.isImporting || STATE.isGrabbing;
        },
        addEventListeners() {
            this.courseListEl.addEventListener('click', (e) => {
                if (STATE.isGrabbing) {
                    alert('请先停止抢课再操作列表！');
                    return;
                }
                const target = e.target.closest('button');
                if (!target) return;
                const index = parseInt(target.dataset.index, 10);
                if (target.dataset.action === 'delete') {
                    STATE.courses.splice(index, 1);
                    Persistence.save();
                    this.render();
                }
            });
            document.getElementById('grab-btn').addEventListener('click', () => {
                STATE.isGrabbing ? ExecutionEngine.stop() : ExecutionEngine.start();
            });
            document.getElementById('skip-captcha-checkbox').addEventListener('change', (e) => {
                STATE.skipCaptcha = e.target.checked;
                Persistence.save();
                // 当skipCaptcha变化时，需启动或停止验证码循环
                if (STATE.isGrabbing) {
                    if (STATE.skipCaptcha) {
                        ExecutionEngine.stopCaptchaLoop();
                    } else {
                        ExecutionEngine.startCaptchaLoop();
                    }
                }
            });
            document.getElementById('use-local-lut-checkbox').addEventListener('change', (e) => {
                STATE.useLocalLUT = e.target.checked;
                Persistence.save();
            });

            document.getElementById('concurrency-slider').addEventListener('input', (e) => {
                STATE.concurrency = parseInt(e.target.value, 10);
                document.getElementById('concurrency-value').textContent = STATE.concurrency;
                Persistence.save();
            });
            document.getElementById('clear-btn').addEventListener('click', () => {
                if (STATE.isGrabbing) {
                    alert('请先停止抢课！');
                    return;
                }
                if (confirm('确定要清空所有意向课程吗？')) {
                    STATE.courses = [];
                    Persistence.save();
                    this.render();
                }
            });
            document.getElementById('reset-btn').addEventListener('click', () => {
                if (STATE.isGrabbing) {
                    alert('请先停止抢课！');
                    return;
                }
                STATE.studentId = '';
                STATE.turnId = '';
                STATE.headers = {};
                STATE.isCaptchaLoopRunning = false;
                Persistence.save();
                this.render();
                console.log('[抢课助手] 上下文信息已重置 ');
            });
            document.getElementById('import-btn').addEventListener('click', () => {
                if (STATE.isGrabbing) {
                    alert('请先停止抢课！');
                    return;
                }
                STATE.isImporting = true;
                this.render();
                alert('导入模式已开启！请在选课页面进行一次翻页或筛选操作，脚本即自动捕获当前页所有课程 ');
            });
        }
    };

    // --- 数据持久化 ---
    const Persistence = {
        save() {
            const dataToSave = {
                courses: STATE.courses,
                studentId: STATE.studentId,
                turnId: STATE.turnId,
                headers: STATE.headers,
                skipCaptcha: STATE.skipCaptcha,
                useLocalLUT: STATE.useLocalLUT,
                concurrency: STATE.concurrency,
            };
            GM_setValue('grabber_state', JSON.stringify(dataToSave));
        },
        load() {
            const savedState = GM_getValue('grabber_state');
            if (savedState) {
                const parsed = JSON.parse(savedState);
                STATE.courses = parsed.courses ?? [];
                STATE.studentId = parsed.studentId ?? '';
                STATE.turnId = parsed.turnId ?? '';
                STATE.headers = parsed.headers ?? {};
                STATE.skipCaptcha = parsed.skipCaptcha ?? false;
                STATE.useLocalLUT = parsed.useLocalLUT ?? true;
                STATE.concurrency = parsed.concurrency ?? 5;
            }
        }
    };

    // --- XHR 拦截 ---
    const XHRInterceptor = {
        init() {
            const originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function (body) {
                const url = new URL(this._url, window.location.origin);

                // 捕获手动选课操作
                if (url.pathname.includes('/api/v1/student/course-select/add-predicate')) {
                    try {
                        const payload = JSON.parse(body);
                        const lessonAssoc = payload.requestMiddleDtos[0].lessonAssoc;
                        const studentAssoc = payload.studentAssoc;
                        const turnId = payload.courseSelectTurnAssoc;
                        console.log(`[抢课助手] 捕获到 Lesson ${lessonAssoc}`);
                        if (Object.keys(STATE.headers).length === 0) {
                            STATE.headers = {...this._headers};
                            delete STATE.headers['Host'];
                            delete STATE.headers['Content-Length'];
                            console.log('[抢课助手] 全局 Headers 已捕获:', STATE.headers);
                        }
                        STATE.studentId = studentAssoc.toString();
                        STATE.turnId = turnId.toString();
                        if (!STATE.courses.some(c => c.lessonAssoc === lessonAssoc)) {
                            STATE.courses.push({lessonAssoc, status: 'pending'});
                        }
                        Persistence.save();
                        UI.render();
                    } catch (e) {
                        console.error('[抢课助手] 解析请求 payload 失败:', e);
                    }
                }
                // 捕获页面课程列表加载操作（仅在导入模式下）
                else if (STATE.isImporting && url.pathname.includes('/api/v1/student/course-select/std-count')) {
                    const lessonIdsParam = url.searchParams.get('lessonIds');
                    if (lessonIdsParam) {
                        const lessonIds = lessonIdsParam.split(',');
                        let newCoursesCount = 0;
                        lessonIds.forEach(idStr => {
                            const lessonAssoc = parseInt(idStr, 10);
                            if (!isNaN(lessonAssoc) && !STATE.courses.some(c => c.lessonAssoc === lessonAssoc)) {
                                STATE.courses.push({lessonAssoc, status: 'pending'});
                                newCoursesCount++;
                            }
                        });
                        console.log(`[抢课助手] 导入 ${newCoursesCount} 门新课程 `);
                        STATE.isImporting = false; // 导入一次后自动关闭
                        Persistence.save();
                        UI.render();
                    }
                }
                return originalSend.apply(this, arguments);
            };
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (method, url) {
                this._url = url;
                this._headers = {};
                return originalOpen.apply(this, arguments);
            };
            const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
                this._headers[header] = value;
                return originalSetRequestHeader.apply(this, arguments);
            };
        }
    };

    // --- 验证码求解  ---
    const CaptchaSolver = {
        opencvLoaded: null,
        init() {
            // 基于 openCV 实现边缘检测匹配 cutImg 位置
            if (this.opencvLoaded) return this.opencvLoaded;
            this.opencvLoaded = new Promise((resolve, reject) => {
                if (typeof cv !== 'undefined') return resolve();
                console.log('[抢课助手] 正在加载OpenCV.js...');
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: 'https://docs.opencv.org/4.8.0/opencv.js',
                    onload: (response) => {
                        const script = document.createElement('script');
                        script.innerHTML = response.responseText;
                        document.head.appendChild(script);
                        const interval = setInterval(() => {
                            if (typeof cv !== 'undefined') {
                                clearInterval(interval);
                                console.log('[抢课助手] OpenCV.js 初始化成功！');
                                resolve();
                            }
                        }, 100);
                    },
                    onerror: (err) => {
                        console.error('[抢课助手] OpenCV.js 加载失败！', err);
                        reject(err);
                    }
                });
            });
            return this.opencvLoaded;
        },
        async calculate(bgBase64, sliderBase64) {
            await this.init();
            const loadImage = (src) => new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = src;
            });
            const bgImg = await loadImage('data:image/jpeg;base64,' + bgBase64);
            const sliderImg = await loadImage('data:image/png;base64,' + sliderBase64);
            let bgMat = cv.imread(bgImg), sliderMat = cv.imread(sliderImg), bgGray = new cv.Mat(),
                sliderGray = new cv.Mat(), bgEdges = new cv.Mat(), sliderEdges = new cv.Mat(), result = new cv.Mat();
            try {
                cv.cvtColor(bgMat, bgGray, cv.COLOR_RGBA2GRAY);
                cv.cvtColor(sliderMat, sliderGray, cv.COLOR_RGBA2GRAY);
                cv.Canny(bgGray, bgEdges, 250, 255);
                cv.Canny(sliderGray, sliderEdges, 252, 255);
                // 经验值，您可自行调整
                cv.matchTemplate(bgEdges, sliderEdges, result, cv.TM_CCOEFF_NORMED);
                return cv.minMaxLoc(result).maxLoc.x;
            } finally {
                bgMat.delete();
                sliderMat.delete();
                bgGray.delete();
                sliderGray.delete();
                bgEdges.delete();
                sliderEdges.delete();
                result.delete();
            }
        }
    };

    // --- 抢课执行引擎 ---
    const ExecutionEngine = {
        captchaMap: new Map(),
        // 加载已有的 captchaRecords
        loadCaptchaRecords() {
            return new Promise((resolve, reject) => {
                try {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.multiple = true;
                    input.style.display = 'none';
                    document.body.appendChild(input);

                    input.addEventListener('change', async (event) => {
                        try {
                            const files = Array.from(event.target.files);
                            if (LIST_OF_IMGINDEX.filter(imgIndex => {
                                return !files.some(f => f.name.includes(imgIndex));
                            }).length > 0) {
                                throw new Error(`缺失必需文件, 已选择: ${files.map(f => f.name).join(', ')}`);
                            }
                            // 并行加载
                            const results = await Promise.all(
                                files.map(async file => {
                                    try {
                                        const text = await new Promise((res, rej) => {
                                            const reader = new FileReader();
                                            reader.onload = () => res(reader.result);
                                            reader.onerror = () => rej(new Error(`读取失败: ${file.name}`));
                                            reader.readAsText(file);
                                        });
                                        // 解析JSON
                                        const valueMap = new Map(Object.entries(JSON.parse(text)));
                                        return {imgIndex: file.name.replace(".json", ""), valueMap};
                                    } catch (err) {
                                        throw new Error(`解析失败 [${file.name}]: ${err.message}`);
                                    }
                                })
                            );
                            results.forEach(result => {
                                this.captchaMap.set(result.imgIndex, result.valueMap);
                                console.log(`✅ 已加载: ${result.imgIndex} (${result.valueMap.size} 项)`);
                            });

                            console.log('所有配置文件加载完成!');
                            resolve();
                        } catch (err) {
                            reject(new Error(`初始化失败 - ${err.message}`));
                        } finally {
                            // 清理DOM元素
                            input.remove();
                        }
                    });
                    alert("接下来请选中全部的 6 个 imgIndex.json 文件");
                    input.click();
                } catch (err) {
                    reject(new Error(`初始化失败 - ${err.message}`));
                }
            });
        },
        async start() {
            if (!STATE.studentId || !STATE.turnId || Object.keys(STATE.headers).length === 0) {
                alert('上下文信息不完整，请先在网页上进行一次手动选课操作以自动捕获 ');
                return;
            }
            if (STATE.courses.length === 0) {
                alert('意向课程列表为空！');
                return;
            }
            STATE.isGrabbing = true;
            // 重置课程状态
            STATE.courses.forEach(c => c.status = 'pending');
            UI.render();
            console.log('%c[抢课助手] 开始抢课...', 'color: green;');

            if (!STATE.skipCaptcha) {
                // 加载本地查找表
                if (STATE.useLocalLUT && !this.captchaMap.size) {
                    try {
                        await this.loadCaptchaRecords();
                    } catch (error) {
                        console.error('[抢课助手] 本地 captchaRecords 加载失败，验证码循环无法启动');
                        STATE.isCaptchaLoopRunning = false;
                        return;
                    }
                }
                this.startCaptchaLoop();
            }

            STATE.reqTimestamps = [];
            if (ENABLE_RPS_CALCULATING) {
                STATE.rpsIntervalId = setInterval(this.calculateRPS.bind(this), 1000); // 每1000ms更新一次RPS
            }

            for (const course of STATE.courses) {
                for (let i = 0; i < STATE.concurrency; i++) { // 使用状态中的并发数
                    const workerId = `${course.lessonAssoc}-${i}`;
                    const worker =
                        new Worker(URL.createObjectURL(new Blob([workerCode], {type: 'application/javascript'})));
                    worker.onmessage = (event) => {
                        const {type, requestId, details, message} = event.data;
                        if (type === 'gm_request') {
                            GM_xmlhttpRequest({
                                ...details,
                                onload: (res) => {
                                    worker.postMessage({
                                        type: 'request_response',
                                        requestId,
                                        response: {responseText: res.responseText, status: res.status}
                                    });
                                    if (ENABLE_RPS_CALCULATING) STATE.reqTimestamps.push(Date.now()); // 记录请求完成时间，便于计算 RPS
                                },
                                onerror: (err) => {
                                    worker.postMessage({type: 'request_response', requestId, error: err.toString()});
                                    if (ENABLE_RPS_CALCULATING) STATE.reqTimestamps.push(Date.now());
                                }
                            });
                        } else if (type === 'log') {
                            console.log(`[实例 ${i}] ${message}`);
                        } else if (type === 'success') {
                            const {lessonAssoc} = event.data;
                            console.log(`%c[抢课助手] 课程 ${lessonAssoc} 抢课成功！正在终止该课程的其他实例...`, 'color: green; font-weight: bold;');

                            const courseToUpdate = STATE.courses.find(c => c.lessonAssoc === lessonAssoc);
                            if (courseToUpdate) courseToUpdate.status = 'success';

                            // 终止所有与此课程相关的worker
                            for (const [id, w] of STATE.activeWorkers.entries()) {
                                if (id.startsWith(lessonAssoc + '-')) {
                                    w.postMessage({type: 'stop'});
                                    STATE.activeWorkers.delete(id);
                                }
                            }
                            UI.render();
                        }
                    };
                    worker.postMessage({
                        type: 'start',
                        data: {
                            studentId: STATE.studentId,
                            turnId: STATE.turnId,
                            lessonAssoc: course.lessonAssoc,
                            headers: STATE.headers
                        }
                    });
                    setTimeout(() => {
                        STATE.activeWorkers.set(workerId, worker);
                    }, 1000 / STATE.concurrency);  // 避免 Worker 集中启动
                }
            }
        },

        async startCaptchaLoop() {
            if (STATE.isCaptchaLoopRunning) return;

            console.log('[抢课助手] 启动验证码循环...');
            STATE.isCaptchaLoopRunning = true;

            // 确保OpenCV已加载
            try {
                await CaptchaSolver.init();
            } catch (error) {
                console.error('[抢课助手] OpenCV加载失败，验证码循环无法启动');
                STATE.isCaptchaLoopRunning = false;
                return;
            }

            // 启动验证码 Loop
            const captchaLoop = async () => {
                if (!STATE.isCaptchaLoopRunning) return;

                try {
                    console.log('[验证码 Loop] 开始新一轮验证码验证...');

                    const randomImgUrl = `/api/v1/student/course-select/getRandomImg?studentId=${STATE.studentId}&turnId=${STATE.turnId}`;
                    const randomImgResponse = await this.makeRequest('GET', randomImgUrl, STATE.headers);
                    const randomImgParsed = JSON.parse(randomImgResponse.responseText);
                    if (randomImgParsed.result !== 0 || !randomImgParsed.data) {
                        throw new Error(`获取随机验证码失败: ${randomImgParsed.message || '无有效数据'}`);
                    }

                    const {imgIndex, posIndex} = randomImgParsed.data;
                    // console.log(`[验证码 Loop] 获取到验证码参数: imgIndex=${imgIndex}, posIndex=${posIndex}`);

                    let moveEndX;
                    if (STATE.useLocalLUT/* && this.captchaMap.get(imgIndex).has(posIndex)*/) {
                        moveEndX = this.captchaMap.get(imgIndex).get(posIndex);
                    } else {
                        // 跨域获取验证码图片
                        const cdnUrl = `https://cdn-fudan.demo.supwisdom.com/verify/static/verify-image/${imgIndex}/${posIndex}/verify-image.json`;
                        const cdnHeaders = {
                            ...STATE.headers,
                            'Host': 'cdn-fudan.demo.supwisdom.com',
                            'Origin': 'https://xk.fudan.edu.cn',
                            'Referer': 'https://xk.fudan.edu.cn/',
                            'Sec-Fetch-Site': 'cross-site'
                        };
                        const cdnResponse = await this.makeRequest('GET', cdnUrl, cdnHeaders);
                        const imgParsed = JSON.parse(JSON.parse(cdnResponse.responseText).data);
                        moveEndX = await CaptchaSolver.calculate(imgParsed.SrcImage, imgParsed.CutImage);
                    }
                    // console.log(`[验证码 Loop] 滑块距离: ${moveEndX}`);

                    const rstImgUrl = `/api/v1/student/course-select/rstImgSwipe?moveEndX=${moveEndX}&wbili=1&studentId=${STATE.studentId}&turnId=${STATE.turnId}`;
                    if (NEGLECT_CAPTCHA_VERIFICATION_RESPONSE) {
                        this.makeRequest('GET', rstImgUrl, STATE.headers).catch(error => {
                            console.error(`[验证码 Loop] 错误: ${error.message}`);
                        });
                        captchaLoop();
                        return;
                    }
                    const rstResponse = await this.makeRequest('GET', rstImgUrl, STATE.headers);
                    const rstData = JSON.parse(rstResponse.responseText).data;

                    if (rstData && rstData.success) {
                        // console.log('[验证码 Loop] 滑块验证成功！');
                        captchaLoop();
                    } else {
                        throw new Error('滑块验证失败');
                    }

                } catch (error) {
                    console.error(`[验证码 Loop] 错误: ${error.message}`);
                    // 忽略任何错误
                    captchaLoop();
                }
            };

            // 启动循环
            captchaLoop();
        },

        // 发送请求
        makeRequest(method, url, headers) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method,
                    url,
                    headers,
                    onload: ENABLE_RPS_CALCULATING ? (res) => {
                        STATE.reqTimestamps.push(Date.now());
                        resolve(res);
                    } : (res) => {
                        resolve(res);
                    },
                    onerror: ENABLE_RPS_CALCULATING ? (err) => {
                        STATE.reqTimestamps.push(Date.now());
                        reject(err);
                    } : (err) => {
                        reject(err);
                    }
                });
            });
        },

        stopCaptchaLoop() {
            STATE.isCaptchaLoopRunning = false;
            console.log('[抢课助手] 验证码循环已停止');
        },

        stop() {
            console.log('[抢课助手] 正在停止所有抢课任务...');
            STATE.activeWorkers.forEach((worker) => {
                worker.postMessage({type: 'stop'});
            });
            STATE.activeWorkers.clear();
            STATE.isGrabbing = false;

            this.stopCaptchaLoop();

            // RPS 计数停止
            if (ENABLE_RPS_CALCULATING) {
                clearInterval(STATE.rpsIntervalId);
                STATE.rpsIntervalId = null;
                STATE.reqTimestamps = [];
                STATE.rps = 0;
            }

            UI.render();
            console.log('%c[抢课助手] 所有任务已停止', 'color: red;');
        },

        calculateRPS() {
            STATE.rps =
                STATE.reqTimestamps.filter(timestamp => (Date.now() - timestamp) < 1000).length;
            UI.render();
        }
    };

    function init() {
        console.log('[抢课助手] 脚本已启动 ');
        Persistence.load();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                UI.createPanel();
                UI.render();
            });
        } else {
            UI.createPanel();
            UI.render();
        }
        XHRInterceptor.init();
    }

    init();

})();
