/**
 * DBS2TSV Test Runner
 * Compares parsed results with expected correct_result.tsv
 */
const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');
const CoreParser = require('../parser.js');

// ANSI colors for terminal
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

async function runTests() {
    console.log('🚀 DBS2TSV Test Runner\n');

    // Load expected results
    const expectedPath = path.join(__dirname, 'correct_result.tsv');
    const expectedContent = fs.readFileSync(expectedPath, 'utf-8');
    const expectedLines = expectedContent.trim().split('\n');
    const expectedRecords = expectedLines.slice(1).map(line => {
        const [date, description, debit, credit, balance, currency] = line.split('\t');
        return { date, description, debit: debit || '', credit: credit || '', balance, currency };
    });

    console.log(`📋 预期记录数: ${expectedRecords.length}`);

    // Parse PDFs
    const dbsPath = path.join(__dirname, 'Statement_sample.pdf');
    const paylahPath = path.join(__dirname, 'paylah_sample.pdf');

    const dbsData = new Uint8Array(fs.readFileSync(dbsPath));
    const payData = new Uint8Array(fs.readFileSync(paylahPath));

    const dbs = await CoreParser.parseDBSPDF(dbsData, pdfjsLib);
    const pay = await CoreParser.parsePayLahPDF(payData, pdfjsLib);

    console.log(`📊 解析 DBS 记录数: ${dbs.length}`);
    console.log(`📊 解析 PayLah 记录数: ${pay.length}`);

    // Apply matching
    CoreParser.matchTransactions(dbs, pay);

    // Apply description replacement (same as app.js)
    dbs.forEach(tx => {
        if (tx.matchId) {
            const match = pay.find(p => p.matchId === tx.matchId);
            if (match) {
                tx.description = `[PayLah] ${match.description}`;
            }
        }
    });

    // Compare results
    console.log('\n--- 对比结果 ---\n');

    let passed = 0;
    let failed = 0;
    const errors = [];

    for (let i = 0; i < expectedRecords.length; i++) {
        const expected = expectedRecords[i];
        const actual = dbs[i];

        if (!actual) {
            failed++;
            errors.push(`行 ${i + 2}: 缺少记录 (预期: ${expected.date} ${expected.description.substring(0, 30)}...)`);
            continue;
        }

        // Compare fields
        const dateMatch = expected.date === actual.date;
        const descMatch = expected.description === actual.description;
        const debitMatch = expected.debit === (actual.debit || '');
        const creditMatch = expected.credit === (actual.credit || '');
        const balanceMatch = expected.balance === actual.balance;
        const currencyMatch = expected.currency === actual.currency;

        if (dateMatch && descMatch && debitMatch && creditMatch && balanceMatch && currencyMatch) {
            passed++;
        } else {
            failed++;
            let diff = [];
            if (!dateMatch) diff.push(`日期: 预期 "${expected.date}" 实际 "${actual.date}"`);
            if (!descMatch) diff.push(`描述: 预期 "${expected.description.substring(0, 30)}..." 实际 "${actual.description?.substring(0, 30)}..."`);
            if (!debitMatch) diff.push(`支出: 预期 "${expected.debit}" 实际 "${actual.debit}"`);
            if (!creditMatch) diff.push(`收入: 预期 "${expected.credit}" 实际 "${actual.credit}"`);
            if (!balanceMatch) diff.push(`余额: 预期 "${expected.balance}" 实际 "${actual.balance}"`);
            if (!currencyMatch) diff.push(`货币: 预期 "${expected.currency}" 实际 "${actual.currency}"`);
            errors.push(`行 ${i + 2}: ${diff.join('; ')}`);
        }
    }

    // Check for extra records
    if (dbs.length > expectedRecords.length) {
        for (let i = expectedRecords.length; i < dbs.length; i++) {
            failed++;
            errors.push(`行 ${i + 2}: 多余记录 (${dbs[i].date} ${dbs[i].description?.substring(0, 30)}...)`);
        }
    }

    // Print results
    console.log(`${GREEN}✅ 通过: ${passed}${RESET}`);
    console.log(`${failed > 0 ? RED : GREEN}❌ 失败: ${failed}${RESET}`);

    if (errors.length > 0) {
        console.log('\n--- 差异详情 ---');
        errors.slice(0, 10).forEach(e => console.log(`  ${e}`));
        if (errors.length > 10) {
            console.log(`  ... 还有 ${errors.length - 10} 个差异`);
        }
    }

    // Exit with appropriate code
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('测试运行失败:', err);
    process.exit(1);
});
