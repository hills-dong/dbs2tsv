/**
 * DBS/PayLah PDF Parser Core Logic
 * Shared between Client-side Web App and Node.js Test Runner.
 */
(function (exports) {

    // ==========================================
    // 1. Constants & Configuration
    // ==========================================

    const COLUMN_BOUNDS = {
        DATE_MAX: 90,
        DESC_MIN: 90,
        DESC_MAX: 330,
        DEBIT_MIN: 330,
        DEBIT_MAX: 420,
        CREDIT_MIN: 420,
        CREDIT_MAX: 500,
        BALANCE_MIN: 500,
        LINE_TOLERANCE: 2
    };

    // ==========================================
    // 2. Helper Functions
    // ==========================================

    function formatDate(dateStr) {
        const parts = dateStr.split('/');
        if (parts.length === 3) {
            return `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
        return dateStr;
    }

    function cleanDescription(desc) {
        return desc.replace(/[\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function cleanAmount(amount) {
        if (!amount) return '';
        const cleaned = amount.trim();
        // Allow negative signs, commas, and decimals
        if (/^-?[\d,]*\.?\d+$/.test(cleaned) || /[\d,]+\.\d{2}[-\s]*(?:CR|DB)?$/.test(cleaned)) {
            // Specific case: "123.45 CR" -> 123.45 (Credit usually handled by column, but PayLah uses suffix)
            // DBS specific cleaning logic is mainly layout based.
            return cleaned;
        }
        return '';
    }

    // Convert "1,234.56" to 1234.56
    function parseAmount(amtStr) {
        if (!amtStr) return 0;
        let s = amtStr.replace(/,/g, '').trim();
        // Handle "CR" suffix? Usually handled by column or separate logic.
        if (s.endsWith('CR')) return parseFloat(s.replace('CR', ''));
        if (s.endsWith('DB')) return -parseFloat(s.replace('DB', ''));
        return parseFloat(s);
    }

    // ==========================================
    // 3. DBS Parsing Logic
    // ==========================================

    // dependency: pdfLib must be passed in (window.pdfjsLib or require('pdfjs-dist'))
    async function parseDBSPDF(arrayBuffer, pdfLib) {
        const loadingTask = pdfLib.getDocument(arrayBuffer);
        const pdf = await loadingTask.promise;
        let allTransactions = [];

        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();

            // Sort items by Y (desc), then X (asc)
            let items = textContent.items.map(item => ({
                text: item.str,
                x: item.transform[4],
                y: item.transform[5],
                h: item.height || 0
            })).sort((a, b) => {
                if (Math.abs(a.y - b.y) < COLUMN_BOUNDS.LINE_TOLERANCE) {
                    return a.x - b.x;
                }
                return b.y - a.y;
            });

            // De-duplicate items at same coordinates
            // PDF sometimes renders duplicate text at identical positions
            const seen = new Set();
            items = items.filter(item => {
                const key = `${item.x.toFixed(1)},${item.y.toFixed(1)},${item.text}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            const pageTransactions = parsePageItems(items);
            allTransactions = allTransactions.concat(pageTransactions);
        }

        return allTransactions;
    }

    function parsePageItems(items) {
        const transactions = [];
        let currentTransaction = null;
        let lastY = -1;

        // Flags to detect table boundaries
        let isInsideTransactionSection = false;
        let currentCurrency = 'SGD';

        for (const item of items) {
            // Detect section boundaries per REQUIREMENTS.md
            const textLower = item.text.toLowerCase();

            // Detect currency from "Total Balance Carried Forward in SGD/USD"
            if (textLower.includes('total balance carried forward in sgd')) {
                if (currentTransaction) {
                    finalizeTransaction(currentTransaction, transactions);
                    currentTransaction = null;
                }
                isInsideTransactionSection = false;
                continue;
            }

            if (textLower.includes('total balance carried forward in usd')) {
                if (currentTransaction) {
                    finalizeTransaction(currentTransaction, transactions);
                    currentTransaction = null;
                }
                isInsideTransactionSection = false;
                continue;
            }

            // Detect currency markers (these appear near Balance Brought Forward)
            // e.g., "SGD 01.23" or "USD 0.00" on the same line
            if (item.text.trim().startsWith('USD ')) {
                currentCurrency = 'USD';
            } else if (item.text.trim().startsWith('SGD ')) {
                currentCurrency = 'SGD';
            }

            // Start parsing after "Balance Brought Forward"
            if (textLower.includes('balance brought forward')) {
                isInsideTransactionSection = true;
                continue;
            }

            // Stop parsing at "Balance Carried Forward" (end of section)
            if (isInsideTransactionSection && textLower.includes('balance carried forward')) {
                if (currentTransaction) {
                    finalizeTransaction(currentTransaction, transactions);
                    currentTransaction = null;
                }
                isInsideTransactionSection = false;
                continue;
            }

            // Skip items outside of transaction section
            if (!isInsideTransactionSection) {
                continue;
            }

            // Check for date in first column - this creates a new transaction
            // Date detection should not depend on isNewLine because empty strings
            // at the same Y coordinate can falsely update lastY
            const datePattern = /^\d{2}\s[A-Z][a-z]{2}/; // "31 Dec"
            const dateSlashPattern = /^\d{2}\/\d{2}\/\d{4}/; // "30/11/2025"
            const isDateItem = item.x < COLUMN_BOUNDS.DATE_MAX &&
                (datePattern.test(item.text) || dateSlashPattern.test(item.text));

            if (isDateItem) {
                // Finalize any pending transaction
                if (currentTransaction) {
                    finalizeTransaction(currentTransaction, transactions);
                }

                // Start new transaction with current currency
                currentTransaction = {
                    date: item.text,
                    description: '',
                    debit: '',
                    credit: '',
                    balance: '',
                    currency: currentCurrency,
                    rawLines: [item.y]
                };

                lastY = item.y;
                continue;
            }

            // Update lastY for non-date items
            const isNewLine = Math.abs(item.y - lastY) > COLUMN_BOUNDS.LINE_TOLERANCE;
            if (isNewLine) {
                lastY = item.y;
            }

            // If we are aggregating a transaction
            if (currentTransaction) {
                const dateLineY = currentTransaction.rawLines[0];
                const lastDescLineY = currentTransaction.rawLines[currentTransaction.rawLines.length - 1];

                // If on the same line as the date (approx 5px tolerance):
                // Capture debit, credit, balance, and description
                if (Math.abs(item.y - dateLineY) < 5) {
                    if (item.x > COLUMN_BOUNDS.DESC_MIN && item.x < COLUMN_BOUNDS.DESC_MAX) {
                        currentTransaction.description += ' ' + item.text;
                    }
                    else if (item.x > COLUMN_BOUNDS.DEBIT_MIN && item.x < COLUMN_BOUNDS.DEBIT_MAX) {
                        currentTransaction.debit += item.text;
                    }
                    else if (item.x > COLUMN_BOUNDS.CREDIT_MIN && item.x < COLUMN_BOUNDS.CREDIT_MAX) {
                        currentTransaction.credit += item.text;
                    }
                    else if (item.x > COLUMN_BOUNDS.BALANCE_MIN) {
                        currentTransaction.balance += item.text;
                    }
                }
                // DBS descriptions often wrap to the NEXT line without a date.
                // Only append to description (not debit/credit/balance) for wrapped lines.
                else if (Math.abs(item.y - lastDescLineY) < 15 && Math.abs(item.y - lastDescLineY) > 2) {
                    // It's strictly below the previous line.
                    // Only append description content (not amounts)
                    if (item.x > COLUMN_BOUNDS.DESC_MIN && item.x < COLUMN_BOUNDS.DESC_MAX) {
                        currentTransaction.description += ' ' + item.text;
                        currentTransaction.rawLines.push(item.y);
                    }
                }
            }
        }

        // Final one
        if (currentTransaction) {
            finalizeTransaction(currentTransaction, transactions);
        }

        return transactions;
    }

    function finalizeTransaction(tx, list) {
        // Clean fields
        tx.description = cleanDescription(tx.description);
        tx.debit = cleanAmount(tx.debit);
        tx.credit = cleanAmount(tx.credit);
        tx.balance = cleanAmount(tx.balance);

        // Format Date to YYYY-MM-DD
        if (tx.date.includes('/')) {
            tx.date = formatDate(tx.date);
        } else {
            try {
                const dateObj = new Date(tx.date);
                if (!isNaN(dateObj)) tx.date = dateObj.toISOString().split('T')[0];
            } catch (e) { }
        }

        // Validate: Must have amount
        if (tx.debit || tx.credit) {
            if (!tx.currency) tx.currency = 'SGD';
            list.push(tx);
        }
    }

    // ==========================================
    // 4. PayLah Parsing Logic
    // ==========================================

    async function parsePayLahPDF(arrayBuffer, pdfLib) {
        const loadingTask = pdfLib.getDocument(arrayBuffer);
        const pdf = await loadingTask.promise;
        const textContent = [];

        // 1. Extract All Text Lines first
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();

            // Sort by Y desc
            const items = content.items.map(item => ({
                str: item.str,
                y: item.transform[5],
                x: item.transform[4]
            })).sort((a, b) => b.y - a.y);

            // Group by Line
            let currentLineY = -1;
            let currentLineText = '';

            items.forEach(item => {
                if (Math.abs(item.y - currentLineY) > 5) {
                    if (currentLineText) textContent.push(currentLineText.trim());
                    currentLineY = item.y;
                    currentLineText = item.str;
                } else {
                    currentLineText += ' ' + item.str;
                }
            });
            if (currentLineText) textContent.push(currentLineText.trim());
        }

        // 2. Parse Transactions
        const transactions = [];
        let currentYear = null;  // Will be inferred from PDF

        // Regex for PayLah Header (Statement Date) to infer year
        // Pattern 1: "Statement Date : 13 Jan 2025" (same line)
        const headerYearRegex = /Statement Date\s*[:\.]?\s*\d{1,2}\s+[A-Za-z]{3}\s+(\d{4})/i;
        // Pattern 2: Standalone date "17 Dec 2025" followed by numbers
        const standaloneDateRegex = /^(\d{1,2}\s+[A-Za-z]{3}\s+(20\d{2}))\s+\d+/;
        // Pattern 3: Any line with DD Mon YYYY format
        const anyDateWithYearRegex = /\d{1,2}\s+[A-Za-z]{3}\s+(20\d{2})/;

        for (const line of textContent) {
            let m = line.match(headerYearRegex);
            if (m) {
                currentYear = parseInt(m[1], 10);
                break;
            }
            m = line.match(standaloneDateRegex);
            if (m) {
                currentYear = parseInt(m[2], 10);
                break;
            }
        }

        // Fallback: scan for any line with year
        if (!currentYear) {
            for (const line of textContent) {
                const m = line.match(anyDateWithYearRegex);
                if (m) {
                    currentYear = parseInt(m[1], 10);
                    break;
                }
            }
        }

        // Ultimate fallback: use current year
        if (!currentYear) {
            currentYear = new Date().getFullYear();
            console.warn('PayLah: Could not extract year from PDF, using current year:', currentYear);
        }

        // PayLah format: "01 Jan Transfer to 91234567 50.00"
        // Or multiple lines.
        // Regex: Date (DD Mon) + Description + Amount (with optional CR/DB)
        const checkRegex = /^(\d{1,2}\s[A-Za-z]{3})\s+(.+?)\s+(\d{1,3}(?:,\d{3})*\.\d{2}(?:\s*[CD][RB])?)$/;

        // We need a smarter parser that handles year crossover.
        // Let's create an intermediate list of raw items first.
        const rawItems = [];

        for (const line of textContent) {
            // Try match standard transaction line
            let match = line.match(checkRegex);
            if (match) {
                rawItems.push({
                    dateStr: match[1],
                    desc: match[2],
                    amountStr: match[3],
                    fullLine: line
                });
            }
        }

        // 3. Process Dates with Year Inference
        // Logic: Iterate chronological? PayLah PDF is usually chronological?
        // Actually usually standard chronological.
        // But if statement covers Dec 2024 to Jan 2025.
        // "15 Dec" comes first, then "02 Jan".
        // We use the 'inferPayLahDates' logic.
        const processedItems = inferPayLahDates(rawItems, currentYear);

        return processedItems.map(item => {
            const rawAmt = item.amountStr;
            let type = 'DB'; // Default Debit

            // Check Suffix on original string
            if (rawAmt.endsWith('CR')) {
                type = 'CR';
            } else if (rawAmt.endsWith('DB')) {
                type = 'DB';
            } else {
                // Heuristic: "Top-up" or "Receive" = Credit
                if (item.desc.toLowerCase().includes('top-up') || item.desc.toLowerCase().includes('received')) {
                    type = 'CR';
                }
            }

            // Parse amount (remove commas and suffix)
            const amount = parseFloat(rawAmt.replace(/,/g, '').replace(/[CD][RB]$/, '')) || 0;

            return {
                date: item.fullDate,
                description: item.desc,
                debit: type === 'DB' ? amount.toFixed(2) : '',
                credit: type === 'CR' ? amount.toFixed(2) : '',
                // PayLah doesn't typically show running balance on every line in this parser logic?
                // Or maybe it does but we ignore it for now.
                currency: 'SGD'
            };
        });
    }

    function inferPayLahDates(items, statementYear) {
        // Simple logic:
        // Identify Month transitions.
        // If we see Dec then Jan, year++?
        // Or usually statement assumes 'statementYear' is the End Year.
        // e.g. Jan 2025 Statement covers Dec 2024.

        // This is tricky without knowing exact order.
        // Let's assume order is top-down.
        let inferredYear = statementYear;
        // If the statement is Jan 2025, and first item is Dec 15. That Dec is 2024.

        // Let's set initial guess.
        const results = [];

        // We iterate and detecting boundaries.
        // BUT safer approach:
        // Use "Month Index". 
        // 0=Jan, 11=Dec.
        // If current month is 11 (Dec) and next is 0 (Jan), Year increments.
        // If current is 0 (Jan) and next is 11 (Dec), Year decrements (unlikely in PDF order?).
        // Actually DBS Statements are chronological (Oldest to Newest).

        // Let's try to find the "Break Point".
        // Or simpler: Just map months.

        let lastMonthIdx = -1;
        // First pass to determine base year?
        if (items.length > 0) {
            const firstM = new Date(items[0].dateStr + ' 2000').getMonth();
            const lastM = new Date(items[items.length - 1].dateStr + ' 2000').getMonth();

            // If we span Dec->Jan (Cronological), First is Dec, Last is Jan.
            // Statement Year is usually the extraction year (2025). So Jan is 2025. Dec is 2024.
            if (firstM > lastM) {
                // Dec -> Jan transition detected
                inferredYear = statementYear - 1; // Start with previous year
            } else {
                inferredYear = statementYear;
            }
            lastMonthIdx = firstM;
        }

        // Iterate
        items.forEach(item => {
            const d = new Date(item.dateStr + ' 2000'); // Fake year to parse Month
            const mIdx = d.getMonth();

            // Detect Year Jump (Dec -> Jan)
            if (lastMonthIdx === 11 && mIdx === 0) {
                inferredYear++;
            }

            lastMonthIdx = mIdx;

            // Construct full date
            // YYYY-MM-DD
            const monthStr = (mIdx + 1).toString().padStart(2, '0');
            const dayStr = d.getDate().toString().padStart(2, '0');
            item.fullDate = `${inferredYear}-${monthStr}-${dayStr}`;
            results.push(item);
        });

        return results;
    }

    // ==========================================
    // 5. Matching Logic
    // ==========================================

    function matchTransactions(dbs, paylah) {
        // Reset matchIds
        dbs.forEach(d => d.matchId = null);
        paylah.forEach(p => p.matchId = null);

        let matchCount = 0;

        dbs.forEach(d => {
            // Match DBS TOP-UP TO PAYLAH! transactions with PayLah debit records
            if (!d.description.toUpperCase().includes('TOP-UP TO PAYLAH!') || !d.debit) return;

            const dbsVal = parseAmount(d.debit);
            if (dbsVal === 0) return;

            const dDate = new Date(d.date);

            // Find matching PayLah: same amount, same day or next day, not already matched
            const match = paylah.find(p => {
                if (p.matchId || !p.debit) return false;
                if (Math.abs(dbsVal - parseAmount(p.debit)) > 0.01) return false;
                // PayLah date should be same as DBS date or 1 day after
                const pDate = new Date(p.date);
                const diffDays = (pDate - dDate) / (1000 * 60 * 60 * 24);
                return diffDays >= 0 && diffDays <= 1;
            });

            if (match) {
                const id = `M-${++matchCount}`;
                d.matchId = id;
                match.matchId = id;
            }
        });
    }

    // ==========================================
    // Exports
    // ==========================================

    exports.COLUMN_BOUNDS = COLUMN_BOUNDS;
    exports.formatDate = formatDate;
    exports.cleanDescription = cleanDescription;
    exports.cleanAmount = cleanAmount;
    exports.parseDBSPDF = parseDBSPDF;
    exports.parsePayLahPDF = parsePayLahPDF;
    exports.matchTransactions = matchTransactions;

})(typeof exports === 'undefined' ? (window.DBSParser = {}) : exports);
