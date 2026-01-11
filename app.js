// Initialize PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Import Core Parser Logic from parser.js
const { parseDBSPDF, parsePayLahPDF, matchTransactions } = DBSParser;

// DOM Elements - DBS
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const selectFileBtn = document.getElementById('selectFileBtn');
const processingStatus = document.getElementById('processingStatus');
const resultsSection = document.getElementById('resultsSection');
const welcomeMessage = document.getElementById('welcomeMessage');
const errorMessage = document.getElementById('errorMessage');
const errorText = document.getElementById('errorText');
const resultsBody = document.getElementById('resultsBody');
const fileName = document.getElementById('fileName');
const copyBtn = document.getElementById('copyBtn');
const actionsSection = document.getElementById('actionsSection');

// DOM Elements - PayLah
const dropZonePayLah = document.getElementById('dropZonePayLah');
const payLahInput = document.getElementById('payLahInput');
const selectPayLahBtn = document.getElementById('selectPayLahBtn');
const payLahFileName = document.getElementById('payLahFileName');

// DOM Elements - Stats in results header
const statDBS = document.getElementById('statDBS');
const statPayLah = document.getElementById('statPayLah');
const statMatch = document.getElementById('statMatch');

// Global State
let parsedData = [];
let payLahTransactions = [];
let payLahFiles = [];  // Track loaded PayLah files

// Event Listeners - DBS
selectFileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', handleFileSelect);
copyBtn.addEventListener('click', copyToClipboard);

// Drag and Drop Events - DBS
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        handleFile(files[0]);
    }
});

dropZone.addEventListener('click', (e) => {
    if (e.target !== selectFileBtn) {
        fileInput.click();
    }
});

// Event Listeners - PayLah
if (selectPayLahBtn) {
    selectPayLahBtn.addEventListener('click', () => payLahInput.click());
}
if (payLahInput) {
    payLahInput.addEventListener('change', handlePayLahSelect);
}
if (dropZonePayLah) {
    dropZonePayLah.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZonePayLah.classList.add('drag-over');
    });
    dropZonePayLah.addEventListener('dragleave', () => {
        dropZonePayLah.classList.remove('drag-over');
    });
    dropZonePayLah.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZonePayLah.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files);
        files.forEach(file => handlePayLahFile(file));
    });
    dropZonePayLah.addEventListener('click', (e) => {
        if (e.target !== selectPayLahBtn) {
            payLahInput.click();
        }
    });
}

// File Handling - DBS

function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) {
        handleFile(file);
    }
    // Allow selecting the same file again if needed
    e.target.value = '';
}

// File Handling - PayLah (multiple files)
function handlePayLahSelect(e) {
    const files = Array.from(e.target.files);
    files.forEach(file => handlePayLahFile(file));
    // Allow selecting the same file again if needed
    e.target.value = '';
}

async function handleFile(file) {
    const isPDF = file.type === 'application/pdf' ||
        file.type === 'application/x-pdf' ||
        file.name.toLowerCase().endsWith('.pdf');

    if (!isPDF) {
        showError('请选择有效的 PDF 文件');
        return;
    }

    hideError();
    hideResults();
    showProcessing();

    try {
        const arrayBuffer = await file.arrayBuffer();
        const transactions = await parseDBSPDF(arrayBuffer, pdfjsLib);

        if (transactions.length === 0) {
            showError('未找到有效的交易记录。请确保这是 DBS 银行的电子账单。');
            hideProcessing();
            return;
        }

        // DBS transactions should NOT be deduplicated
        // Same day, same amount transactions are valid different transactions (e.g., multiple bus rides)
        // Deduplication is only for PayLah multi-file upload to prevent re-importing same records
        parsedData = transactions;

        // Apply PayLah matching if available
        if (payLahTransactions.length > 0) {
            applyPayLahMatching();
        }

        displayResults(parsedData, file.name);
        hideProcessing();
        showResults();
    } catch (error) {
        console.error('解析错误:', error);
        showError(`解析失败: ${error.message}`);
        hideProcessing();
    }
}

// PayLah File Handling (multi-file support)
async function handlePayLahFile(file) {
    const isPDF = file.type === 'application/pdf' ||
        file.type === 'application/x-pdf' ||
        file.name.toLowerCase().endsWith('.pdf');

    if (!isPDF) return;

    // Check if file already loaded
    if (payLahFiles.some(f => f.name === file.name)) return;

    try {
        const arrayBuffer = await file.arrayBuffer();
        const newTransactions = await parsePayLahPDF(arrayBuffer, pdfjsLib);

        if (newTransactions.length > 0) {
            payLahFiles.push({ name: file.name, count: newTransactions.length });
            payLahTransactions.push(...newTransactions);
            console.log(`Added ${newTransactions.length} PayLah transactions.`);

            // Update file list display
            updatePayLahFileList();

            // If DBS data already exists, apply matching
            if (parsedData.length > 0) {
                applyPayLahMatching();
                displayResults(parsedData, fileName.textContent);
            }
        }
    } catch (error) {
        console.error('PayLah 解析错误:', error);
    }
}

function updatePayLahFileList() {
    if (!payLahFileName) return;

    if (payLahFiles.length === 0) {
        payLahFileName.textContent = '未选择';
    } else if (payLahFiles.length === 1) {
        payLahFileName.textContent = payLahFiles[0].name;
    } else {
        payLahFileName.textContent = `${payLahFiles.length} 个文件`;
    }
}

// PayLah Matching Wrapper
function applyPayLahMatching() {
    // Run core matching algorithm
    matchTransactions(parsedData, payLahTransactions);

    // Post-process for UI display
    parsedData.forEach(tx => {
        // 只有包含 TOP-UP TO PAYLAH! 且有支出的交易才需要标记匹配状态
        const isPayLahTopUp = tx.description &&
            tx.description.toUpperCase().includes('TOP-UP TO PAYLAH!') &&
            tx.debit;

        if (isPayLahTopUp) {
            if (tx.matchId) {
                tx.matched = true;
                // Update description to show PayLah merchant details
                const match = payLahTransactions.find(p => p.matchId === tx.matchId);
                if (match && !tx.description.includes('[PayLah]')) {
                    tx.description = `[PayLah] ${match.description}`;
                }
            } else {
                tx.matched = false;  // 标记为匹配失败
            }
        }
        // 非 PayLah TopUp 交易不设置 matched 属性，保持 undefined
    });
}


// Display Functions

/**
 * Validate balance: check if balance = prevBalance - debit + credit
 */
function validateBalance(prevBalance, debit, credit, currentBalance) {
    const toNum = v => parseFloat(String(v || '0').replace(/,/g, '')) || 0;
    const expected = toNum(prevBalance) - toNum(debit) + toNum(credit);
    return Math.abs(expected - toNum(currentBalance)) < 0.01;
}

function displayResults(transactions, filename) {
    resultsBody.innerHTML = '';

    // Track previous balance for validation (grouped by currency)
    const prevBalances = {};

    transactions.forEach((transaction, index) => {
        const row = document.createElement('tr');
        row.style.animation = `fadeInUp 0.3s ease-out ${index * 0.03}s both`;

        // Get previous balance for this currency
        const currency = transaction.currency;
        const prevBalance = prevBalances[currency];

        // Validate balance
        const isBalanceValid = prevBalance === undefined ||
            validateBalance(prevBalance, transaction.debit, transaction.credit, transaction.balance);

        // Update previous balance for next iteration
        prevBalances[currency] = transaction.balance;

        // Create cells
        // Determine description styling based on PayLah matching
        let descClassName = '';
        if (transaction.matched === true) {
            descClassName = 'desc-matched';  // Successfully matched PayLah
        } else if (transaction.matched === false) {
            descClassName = 'desc-unmatched';  // Failed to match PayLah
        }

        const fields = [
            { value: transaction.date, className: '' },
            { value: transaction.description, className: descClassName },
            { value: transaction.debit, className: '' },
            { value: transaction.credit, className: '' },
            { value: transaction.balance, className: isBalanceValid ? 'balance-valid' : 'balance-invalid' },
            { value: transaction.currency, className: '' }
        ];

        fields.forEach(field => {
            const td = document.createElement('td');
            td.textContent = field.value;
            if (field.className) {
                td.classList.add(field.className);
            }
            row.appendChild(td);
        });

        resultsBody.appendChild(row);
    });

    fileName.textContent = filename;

    // Update stats in results header
    updateResultsStats();

    // Show actions section when results are available
    if (actionsSection) {
        actionsSection.style.display = 'block';
    }
}

function updateResultsStats() {
    // Count PayLah TopUp transactions that need matching
    // After matching, description is replaced to [PayLah], so we use the 'matched' property instead
    // matched === true: matched successfully
    // matched === false: should match but failed
    // matched === undefined: not a PayLah TopUp transaction
    const topUpTransactions = parsedData.filter(tx => tx.matched !== undefined);
    const matchedCount = topUpTransactions.filter(tx => tx.matched === true).length;

    // Update header stats
    if (statDBS) {
        statDBS.innerHTML = `银行: <strong>${parsedData.length}</strong>`;
    }
    if (statPayLah) {
        statPayLah.innerHTML = `PayLah: <strong>${payLahTransactions.length}</strong>`;
    }
    if (statMatch) {
        const topUpCount = topUpTransactions.length;
        statMatch.innerHTML = `匹配: <strong>${matchedCount}/${topUpCount}</strong>`;
    }
}

function generateTSV(transactions) {
    const headers = ['日期', '描述', '支出', '收入', '余额', '货币'];
    const rows = [headers.join('\t')];

    transactions.forEach(t => {
        rows.push([
            t.date,
            t.description,
            t.debit,
            t.credit,
            t.balance,
            t.currency
        ].join('\t'));
    });

    return rows.join('\n');
}

async function copyToClipboard() {
    const tsv = generateTSV(parsedData);

    try {
        await navigator.clipboard.writeText(tsv);

        // Visual feedback
        const originalText = copyBtn.innerHTML;
        copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            已复制!
        `;
        copyBtn.style.background = 'linear-gradient(135deg, #2d7eb3 0%, #1a5a8a 100%)';

        setTimeout(() => {
            copyBtn.innerHTML = originalText;
            copyBtn.style.background = '';
        }, 2000);
    } catch (error) {
        console.error('复制失败:', error);
        showError('复制到剪贴板失败，请手动复制表格内容');
    }
}

function resetApp() {
    fileInput.value = '';
    parsedData = [];
    payLahTransactions = [];
    payLahFiles = [];
    hideResults();
    hideError();
    showWelcome();
    resultsBody.innerHTML = '';
    fileName.textContent = '未选择';

    // Reset PayLah file display
    if (payLahInput) payLahInput.value = '';
    if (payLahFileName) payLahFileName.textContent = '未选择';

    // Hide actions section when no file
    if (actionsSection) {
        actionsSection.style.display = 'none';
    }
}

// UI State Management
const toggle = (el, show) => el?.classList.toggle('hidden', !show);

function showProcessing() {
    toggle(processingStatus, true);
    toggle(welcomeMessage, false);
}

function hideProcessing() {
    toggle(processingStatus, false);
}

function showResults() {
    toggle(resultsSection, true);
    toggle(welcomeMessage, false);
}

function hideResults() {
    toggle(resultsSection, false);
}

function showWelcome() {
    toggle(welcomeMessage, true);
}

function hideWelcome() {
    toggle(welcomeMessage, false);
}

function showError(message) {
    errorText.textContent = message;
    toggle(errorMessage, true);
    toggle(welcomeMessage, false);
}

function hideError() {
    toggle(errorMessage, false);
}

// Initialize: hide actions section on load
if (actionsSection) {
    actionsSection.style.display = 'none';
}
