// ==UserScript==
// @name         复旦抢课助手Dev (人工录入助手)
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  用于人工录入无法识别的验证码数据，并打包下载
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
// @connect      cdnjs.cloudflare.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- 全局配置 ---
    const STATE = {
        studentId: '',
        turnId: '',
        headers: {}, // 从原始请求中捕获的全局 HTTP 头
        isGrabbing: false,
        isCaptchaLoopRunning: false
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

    // --- UI 模块 ---
    const UI = {
        panel: null,
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
                        <label for="skip-captcha-checkbox">跳过图形验证</label>
                    </div>
                    <div class="grabber-slider-group">
                        <label for="concurrency-slider">并发数:</label>
                        <input type="range" id="concurrency-slider" min="1" max="10" value="5">
                        <span id="concurrency-value">5</span>
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
            this.applyStyles();
            this.makeDraggable(panel, panel.querySelector('.grabber-header'));
            this.addEventListeners();
        },
        applyStyles() {
            const styles = `
                #grabber-panel { position: fixed; top: 100px; right: 20px; width: 300px; background: #f9f9f9; border: 1px solid #ccc; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); z-index: 9999; font-family: sans-serif; font-size: 14px; }
                .grabber-header { padding: 10px; background: #4a90e2; color: white; font-weight: bold; cursor: move; border-top-left-radius: 8px; border-top-right-radius: 8px; }
                .grabber-body { padding: 15px; }
                .grabber-input-group, .grabber-slider-group, .grabber-info-group { margin-bottom: 15px; display: flex; align-items: center; }
                .grabber-input-group label, .grabber-slider-group label { margin-right: 10px; cursor: pointer; }
                #student-id-input { flex-grow: 1; padding: 5px; border: 1px solid #ccc; border-radius: 4px; background: #eee; }
                #concurrency-slider { flex-grow: 1; }
                #concurrency-value { min-width: 20px; text-align: center; font-weight: bold; }
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

            const grabBtn = document.getElementById('grab-btn');
            const resetBtn = document.getElementById('reset-btn');

            if (STATE.isGrabbing) {
                grabBtn.textContent = '停止抢课';
                grabBtn.classList.add('grabbing');
                resetBtn.disabled = true;
            } else {
                grabBtn.textContent = '开始抢课';
                grabBtn.classList.remove('grabbing');
                resetBtn.disabled = false;
            }
        },
        addEventListeners() {
            document.getElementById('grab-btn').addEventListener('click', () => {
                STATE.isGrabbing ? ExecutionEngine.stop() : ExecutionEngine.start();
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
                this.render();
                console.log('[抢课助手] 上下文信息已重置 ');
            });
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
                        UI.render();
                    } catch (e) {
                        console.error('[抢课助手] 解析请求 payload 失败:', e);
                    }
                }
                // 捕获页面课程列表加载操作（仅在导入模式下）
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
        // 存储imgIndex键值对
        imgIndexMap: new Map(),
        errMap: new Map(LIST_OF_IMGINDEX.map((value) => [value, new Map()])),
        addValue(key1, key2, value) {
            if (!this.imgIndexMap.get(key1).has(key2)) {
                this.imgIndexMap.get(key1).set(key2, value);
                console.info(`%c Add new value:${key2}`, 'color: #0288D1');
            }
        },
        addErrValue(key1, key2, value) {
            this.errMap.get(key1).set(key2, value);
        },
        // 使用 JSZip 支持将捕获的数据打包下载
        initJSZip() {
            return new Promise((resolve, reject) => {
                if (typeof JSZip !== 'undefined') return resolve();
                console.log('[抢课助手] 正在加载 JSZip...');
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
                    onload: (response) => {
                        const script = document.createElement('script');
                        script.innerHTML = response.responseText;
                        document.head.appendChild(script);
                        const interval = setInterval(() => {
                            if (typeof JSZip !== 'undefined') {
                                clearInterval(interval);
                                console.log('[抢课助手] JSZip 初始化成功！');
                                resolve();
                            }
                        }, 100);
                    },
                    onerror: (err) => {
                        console.error('[抢课助手] JSZip 加载失败！', err);
                        reject(err);
                    }
                });
            });
        },
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
                                this.imgIndexMap.set(result.imgIndex, result.valueMap);
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

            STATE.isGrabbing = true;

            UI.render();
            console.log('%c[抢课助手] 开始抢课...', 'color: green;');

            this.startCaptchaLoop();
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

            try {
                await this.initJSZip();
            } catch (error) {
                console.error('[抢课助手] JSZip 加载失败，验证码循环无法启动');
                STATE.isCaptchaLoopRunning = false;
                return;
            }

            try {
                await this.loadCaptchaRecords();
            } catch (error) {
                console.error('[抢课助手] 本地 captchaRecords 加载失败，验证码循环无法启动');
                console.error(error);
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
                    console.log(`[验证码 Loop] 获取到验证码参数: imgIndex=${imgIndex}, posIndex=${posIndex}`);

                    let moveEndX;
                    if (this.imgIndexMap.get(imgIndex).has(posIndex)) {
                        // console.log(`%c 使用了查找表中数据: ${this.imgIndexMap.get(imgIndex).get(posIndex)}`, 'color: green');
                        // moveEndX = this.imgIndexMap.get(imgIndex).get(posIndex);
                        throw new Error('表中已有相关记录'); // 抛出错误，方便快速重试
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
                        console.log(`[验证码 Loop] 滑块距离: ${moveEndX}`);
                    }

                    const rstImgUrl = `/api/v1/student/course-select/rstImgSwipe?moveEndX=${moveEndX}&wbili=1&studentId=${STATE.studentId}&turnId=${STATE.turnId}`;
                    const rstResponse = await this.makeRequest('GET', rstImgUrl, STATE.headers);
                    const rstData = JSON.parse(rstResponse.responseText).data;

                    if (rstData && rstData.success) {
                        console.log('[验证码 Loop] 滑块验证成功！');
                        this.addValue(imgIndex, posIndex, moveEndX);
                        captchaLoop();
                    } else {
                        this.addErrValue(imgIndex, posIndex, moveEndX);
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
                    onload: (res) => {
                        resolve(res);
                    },
                    onerror: (err) => {
                        reject(err);
                    }
                });
            });
        },

        /**
         * 临时工具函数，将 Map 打包为 ZIP 并下载
         * @param {Map<string, string[]>} dataMap 要打包的数据
         * @param {string} zipName ZIP 文件名（可选，默认为 'captcha.zip'）
         */
        async downloadMap(dataMap, zipName = 'captcha.zip') {
            const zip = new JSZip();

            for (const [key, innerMap] of dataMap.entries()) {
                // 将内层 Map 转换为 JSON
                const jsonContent = JSON.stringify(Object.fromEntries(innerMap), null, 2);
                // 创建 .json 文件
                zip.file(`${key}.json`, jsonContent);
            }

            const content = await zip.generateAsync({type: 'blob'});
            const link = document.createElement('a');
            link.href = URL.createObjectURL(content);
            link.download = zipName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
        },
        /**
         * 人工录入验证码数据
         * @return {Promise<unknown>} 主函数
         */
        async manualCaptchaSolver() {
            // 1. 扁平化待处理的任务队列
            const tasks = [];
            for (const [imgIndex, subMap] of this.errMap) {
                for (const [posIndex, val] of subMap) {
                    tasks.push({imgIndex, posIndex, initialVal: val});
                }
            }

            if (tasks.length === 0) {
                alert('没有需要手动修复的验证码记录！');
                return;
            }

            return new Promise((resolve) => {
                // 2. 创建 UI 模态框
                const modalId = 'manual-solver-modal';
                let modal = document.getElementById(modalId);
                if (!modal) {
                    modal = document.createElement('div');
                    modal.id = modalId;
                    modal.style.cssText = `
                        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                        width: 400px; padding: 20px; background: white; border: 1px solid #ccc;
                        box-shadow: 0 0 20px rgba(0,0,0,0.5); z-index: 10000; font-family: sans-serif;
                        border-radius: 8px; text-align: center;
                    `;
                    document.body.appendChild(modal);
                }

                // 3. 辅助函数：加载图片
                const loadImage = (src) => new Promise((res, rej) => {
                    const img = new Image();
                    img.onload = () => res(img);
                    img.onerror = rej;
                    img.src = src;
                });

                // 4. 处理单个任务的函数
                let currentTaskIndex = 0;
                let srcMat = null;

                const processNext = async () => {
                    // 清理旧资源
                    if (srcMat) {
                        srcMat.delete();
                        srcMat = null;
                    }

                    if (currentTaskIndex >= tasks.length) {
                        modal.innerHTML = `
                            <h3 style="color: green">所有验证码已校对完成！</h3>
                            <p>点击下方按钮关闭窗口并下载数据。</p>
                            <button id="ms-close-btn" style="padding: 10px 20px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">完成并下载</button>
                        `;
                        document.getElementById('ms-close-btn').onclick = () => {
                            modal.remove();
                            resolve();
                        };
                        return;
                    }

                    const task = tasks[currentTaskIndex];
                    modal.innerHTML = `
                        <h3>人工校对 (${currentTaskIndex + 1}/${tasks.length})</h3>
                        <div style="position: relative; display: inline-block;">
                            <canvas id="ms-canvas"></canvas>
                        </div>
                        <div style="margin: 15px 0;">
                            <input type="range" id="ms-slider" min="0" max="300" step="1" style="width: 100%;">
                            <div>当前位置: <span id="ms-val">0</span> px</div>
                        </div>
                        <button id="ms-confirm-btn" style="padding: 8px 16px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">确认并下一个</button>
                        <div style="font-size: 12px; color: #666; margin-top: 10px;">ID: ${task.imgIndex.substring(0, 8)}... Pos: ${task.posIndex}</div>
                    `;

                    const canvas = document.getElementById('ms-canvas');
                    const slider = document.getElementById('ms-slider');
                    const valDisplay = document.getElementById('ms-val');
                    const confirmBtn = document.getElementById('ms-confirm-btn');

                    try {
                        const cdnUrl = `https://cdn-fudan.demo.supwisdom.com/verify/static/verify-image/${task.imgIndex}/${task.posIndex}/verify-image.json`;
                        const cdnHeaders = {
                            ...STATE.headers,
                            'Host': 'cdn-fudan.demo.supwisdom.com',
                            'Origin': 'https://xk.fudan.edu.cn',
                            'Referer': 'https://xk.fudan.edu.cn/',
                            'Sec-Fetch-Site': 'cross-site'
                        };

                        const resp = await this.makeRequest('GET', cdnUrl, cdnHeaders);
                        const data = JSON.parse(JSON.parse(resp.responseText).data);

                        const bgImg = await loadImage('data:image/jpeg;base64,' + data.SrcImage);
                        const cutImg = await loadImage('data:image/png;base64,' + data.CutImage);

                        canvas.width = bgImg.width;
                        canvas.height = bgImg.height;

                        // 初始化 OpenCV Mat
                        srcMat = cv.imread(bgImg);
                        const sliderMat = cv.imread(cutImg);

                        // 提前把宽和高取出来存入普通变量
                        const sliderWidth = sliderMat.cols;
                        const sliderHeight = sliderMat.rows;

                        // 获取 Y 坐标
                        let bgGray = new cv.Mat(), sliderGray = new cv.Mat(),
                            bgEdges = new cv.Mat(), sliderEdges = new cv.Mat(), result = new cv.Mat();
                        let fixedY = 0;

                        try {
                            cv.cvtColor(srcMat, bgGray, cv.COLOR_RGBA2GRAY);
                            cv.cvtColor(sliderMat, sliderGray, cv.COLOR_RGBA2GRAY);
                            cv.Canny(bgGray, bgEdges, 250, 255);
                            cv.Canny(sliderGray, sliderEdges, 252, 255);
                            cv.matchTemplate(bgEdges, sliderEdges, result, cv.TM_CCOEFF_NORMED);
                            const mm = cv.minMaxLoc(result);
                            fixedY = mm.maxLoc.y;
                        } finally {
                            bgGray.delete();
                            sliderGray.delete();
                            bgEdges.delete();
                            sliderEdges.delete();
                            result.delete();
                        }

                        // UI 初始设置
                        const initialX = task.initialVal || 0;
                        slider.max = bgImg.width - sliderWidth; // 使用变量
                        slider.value = initialX;
                        valDisplay.innerText = initialX;

                        // 绘制函数
                        const draw = (x) => {
                            if (!srcMat || srcMat.isDeleted()) return;
                            let dst = srcMat.clone();
                            let point1 = new cv.Point(x, fixedY);
                            // 这里使用缓存的 sliderWidth/Height，而不是访问 sliderMat
                            let point2 = new cv.Point(x + sliderWidth, fixedY + sliderHeight);

                            cv.rectangle(dst, point1, point2, [255, 0, 0, 255], 2);
                            cv.imshow(canvas, dst);
                            dst.delete();
                        };

                        draw(parseInt(initialX));
                        sliderMat.delete();

                        slider.oninput = (e) => {
                            const x = parseInt(e.target.value);
                            valDisplay.innerText = x;
                            draw(x);
                        };

                        confirmBtn.onclick = () => {
                            const correctX = parseInt(slider.value);
                            console.log(`[人工校对] ${task.imgIndex} : ${task.posIndex} <-> ${correctX}`);
                            this.addValue(task.imgIndex, task.posIndex, correctX);

                            currentTaskIndex++;
                            processNext();
                        };

                    } catch (err) {
                        console.error("处理出错", err);
                        alert("处理出错，跳过: " + err.message);
                        currentTaskIndex++;
                        processNext();
                    }
                };

                processNext();
            });
        },
        async stopCaptchaLoop() {
            STATE.isCaptchaLoopRunning = false;
            console.log('[抢课助手] 验证码循环已停止');
            console.log('接下来您需要手动解决那些错误的验证码: ');
            await this.manualCaptchaSolver();
            console.log('然后，您可以下载以下验证码图片数据以供分析: ');
            await this.downloadMap(this.imgIndexMap);
        },

        stop() {
            console.log('[抢课助手] 正在停止所有抢课任务...');
            STATE.isGrabbing = false;
            this.stopCaptchaLoop();

            UI.render();
            console.log('%c[抢课助手] 所有任务已停止', 'color: red;');
        },

    };

    function init() {
        console.log('[抢课助手] 脚本已启动 ');
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
