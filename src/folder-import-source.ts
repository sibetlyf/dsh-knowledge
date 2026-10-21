import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

export const FOLDER_IMPORT_SOURCE = 'folder-import'
const SEARCH_KEYS = ['导入文件夹', '文件夹', 'folder', 'import']

/**
 * `@` entry for the folder importer. Picking it opens the knowledge workspace
 * on the files view with the folder browser already open; the trigger token is
 * consumed so the composer is left clean.
 */
export function createFolderImportSource(openFolderImport: () => void): InputTriggerSource {
  return {
    trigger: '@',
    name: FOLDER_IMPORT_SOURCE,
    order: 5,
    showGroupTitle: false,
    async candidates(_session, { query, quoted, drilled }) {
      if (quoted || drilled) return []
      const needle = query.trim().toLocaleLowerCase()
      if (needle.length > 0 && !SEARCH_KEYS.some(key => key.includes(needle) || needle.includes(key))) return []
      return [{
        name: '导入文件夹',
        label: '导入文件夹…',
        icon: 'folder' as const,
        section: '知识库操作',
        description: '选择本机文件夹，自动归档、分类并加入知识库',
        hint: '本机目录',
        value: 'folder-import',
      }]
    },
    onPick({ action }) {
      if (action !== 'pick') return undefined
      openFolderImport()
      return { text: '' }
    },
  }
}
