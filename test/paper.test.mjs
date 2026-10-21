import assert from 'node:assert/strict'
import test from 'node:test'
import { extractPaperMetadata, categorize } from '../lib/artifacts/paper.js'

test('paper metadata extracts title, abstract, keywords and arXiv categories', () => {
  const text = [
    'arXiv:2401.01234v1 [cs.CL] 5 Jan 2024',
    'Retrieval-Augmented Generation for Long Documents',
    'Alice Chen, Bob Li',
    'Abstract',
    'We study retrieval-augmented generation for long documents and introduce a compact',
    'index that improves grounding while reducing token cost. Experiments show consistent gains.',
    'Keywords: retrieval-augmented generation; large language models; document retrieval',
    '1 Introduction',
    'The paper starts here.',
  ].join('\n')
  const paper = extractPaperMetadata(text, 'papers/rag.pdf')
  assert.ok(paper)
  assert.equal(paper.title, 'Retrieval-Augmented Generation for Long Documents')
  assert.match(paper.abstract, /retrieval-augmented generation/u)
  assert.deepEqual(paper.keywords, ['retrieval-augmented generation', 'large language models', 'document retrieval'])
  assert.deepEqual(paper.categories, ['自然语言处理'])
  assert.deepEqual(paper.codes, ['cs.CL'])
  assert.equal(paper.arxivId, '2401.01234')
  assert.equal(paper.year, 2024)
})

test('paper metadata supports Chinese abstracts and keyword classification', () => {
  const text = [
    '面向临床文本的医学信息抽取方法',
    '摘要',
    '本文提出一种面向临床文本的医学信息抽取方法，在多个中文医学数据集上验证了方法的有效性，',
    '并分析了模型在不同科室和不同实体类型上的表现，结果表明该方法优于基线模型。',
    '关键词：医学信息抽取；临床文本；自然语言处理',
    '1 引言',
    '正文。',
  ].join('\n')
  const paper = extractPaperMetadata(text, '临床论文.pdf')
  assert.ok(paper)
  assert.match(paper.title, /临床文本/u)
  assert.match(paper.abstract, /医学信息抽取/u)
  assert.deepEqual(paper.keywords, ['医学信息抽取', '临床文本', '自然语言处理'])
  assert.ok(paper.categories.includes('自然语言处理') || paper.categories.includes('生物医学'))
})

test('non-paper PDFs and unclassified categories stay cautious', () => {
  assert.equal(extractPaperMetadata('Invoice number 42\nTotal: 12 USD', 'invoice.pdf'), undefined)
  assert.deepEqual(categorize([], [], 'an unrelated general document'), ['综合'])
})
