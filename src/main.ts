import { Editor, MarkdownView, Notice, Plugin } from 'obsidian'
import {
  APP_NAMING,
  BibleReferencePluginSettings,
  DEFAULT_SETTINGS,
} from './data/constants'
import { BibleReferenceSettingTab } from './ui/BibleReferenceSettingTab'
import { VerseEditorSuggester } from './suggesetor/VerseEditorSuggester'
import { VerseLookupSuggestModal } from './suggesetor/VerseLookupSuggestModal'
import { VerseOfDayEditorSuggester } from './suggesetor/VerseOfDayEditorSuggester'
import { VerseOfDayModal } from './suggesetor/VerseOfDayModal'
import { getVod } from './provider/VODProvider'
import { splitBibleReference } from './utils/splitBibleReference'
import { VerseOfDaySuggesting } from './verse/VerseOfDaySuggesting'
import { FlagService } from './provider/FeatureFlag'
import { EventStats } from './provider/EventStats'
import { getBibleVersion } from './data/BibleVersionCollection'
import { pluginEvent } from './obsidian/PluginEvent'

export default class BibleReferencePlugin extends Plugin {
  settings: BibleReferencePluginSettings
  verseLookUpModal: VerseLookupSuggestModal
  verseOfDayModal: VerseOfDayModal
  private cachedVerseOfDaySuggesting: {
    verseOfDaySuggesting: VerseOfDaySuggesting
    ttl: number
    timestamp: number
  }
  private ribbonButton?: HTMLElement
  private statusBarIndicator?: HTMLElement

  async onload() {
    console.debug('loading plugin -', APP_NAMING.appName)

    await this.loadSettings()
    this.addSettingTab(new BibleReferenceSettingTab(this.app, this))
    this.registerEditorSuggest(new VerseEditorSuggester(this, this.settings))

    this.verseLookUpModal = new VerseLookupSuggestModal(this, this.settings)
    this.addVerseLookupCommand()
    this.addRibbonButton()

    const flagService = FlagService.getInstace()
    await flagService.init('obsidian-app')
    if (FlagService.instance.isFeatureEnabled('vod')) {
      console.debug('vod feature flag enabled')
      const featureValues = FlagService.instance.getFeatureValue('vod')
      if (featureValues?.editor) {
        this.registerEditorSuggest(
          new VerseOfDayEditorSuggester(this, this.settings)
        )
      }
      if (featureValues?.insert) {
        this.verseOfDayModal = new VerseOfDayModal(this, this.settings)
        this.addVerseOfDayInsertCommand()
      }
      if (featureValues?.notice) {
        this.addVerseOfDayNoticeCommand()
      }
    }

    this.initStatusBarInidactor()
    EventStats.logRecord(this.settings.optOutToEvents)
  }

  onunload() {
    console.debug('unloading plugin', APP_NAMING.appName)
    this.removeRibbonButton()
    this.removeStatusBarIndicator()
    pluginEvent.offAll() // so that we don't have to worry about off ref in multiple places
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
    console.debug('settings is loaded')
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }

  private async getAndCachedVerseOfDay(): Promise<VerseOfDaySuggesting> {
    const { ttl, timestamp, verseOfDaySuggesting } =
      this?.cachedVerseOfDaySuggesting || {}
    if (!verseOfDaySuggesting || timestamp + ttl > Date.now()) {
      const vodResp = await getVod()
      const reference = splitBibleReference(vodResp.verse.details.reference)
      const verseTexts = [vodResp.verse.details.text]
      const vodSuggesting = new VerseOfDaySuggesting(
        this.settings,
        reference,
        verseTexts
      )
      this.cachedVerseOfDaySuggesting = {
        verseOfDaySuggesting: vodSuggesting,
        ttl: 1000 * 60 * 60 * 6,
        timestamp: Date.now(),
      }
    }
    return this.cachedVerseOfDaySuggesting.verseOfDaySuggesting
  }

  private addVerseLookupCommand(): void {
    this.addCommand({
      id: 'obr-lookup',
      name: 'Verse Lookup',
      callback: () => {
        EventStats.logUIOpen(
          'lookupModalOpen',
          { key: `command-lookup`, value: 1 },
          this.settings.optOutToEvents
        )
        this.verseLookUpModal.open()
      },
    })
  }

  private addVerseOfDayNoticeCommand(): void {
    this.addCommand({
      id: 'obr-vod-view-verses-of-day',
      name: 'Verse Of The Day - Notice (10 Seconds)',
      callback: async () => {
        // this.verseOfDayModal.open()
        const verse = await this.getAndCachedVerseOfDay()
        EventStats.logUIOpen(
          'vodEditorOpen',
          { key: `command-vod`, value: 1 },
          this.settings.optOutToEvents
        )
        new Notice(
          `${verse.verseTexts?.join('')} -- ${verse.verseReference.bookName} ${
            verse.verseReference.chapterNumber
          }:${verse.verseReference.verseNumber}`,
          1000 * 10
        )
      },
    })
  }

  private addVerseOfDayInsertCommand(): void {
    this.addCommand({
      id: 'obs-vod-insert-verse-of-day',
      name: 'Verse Of The Day - Insert To Current Note',
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const vodSuggesting = await this.getAndCachedVerseOfDay()
        EventStats.logUIOpen(
          'vodEditorOpen',
          { key: `command-vod-insert`, value: 1 },
          this.settings.optOutToEvents
        )
        editor.replaceSelection(vodSuggesting.allFormattedContent)
      },
    })
  }

  private addRibbonButton(): void {
    // https://lucide.dev/icons/?search=book
    // Obsidian use Lucide Icons
    this.ribbonButton = this.addRibbonIcon(
      'book-open',
      'Bible Verse Lookup',
      (_evt) => {
        EventStats.logUIOpen(
          'lookupModalOpen',
          { key: `ribbon-click`, value: 1 },
          this.settings.optOutToEvents
        )
        this.verseLookUpModal.open()
      }
    )
  }

  private removeRibbonButton(): void {
    if (this.ribbonButton) {
      EventStats.logUIOpen(
        'lookupModalOpen',
        { key: `ribbon-remove`, value: 1 },
        this.settings.optOutToEvents
      )
      this.ribbonButton.parentNode?.removeChild(this.ribbonButton)
    }
  }

  /**
   * To indicate user the Bible version selected
   * @private
   */
  private initStatusBarInidactor(): void {
    // This adds a status bar item to the bottom of the app. Does not work on mobile apps.
    this.removeStatusBarIndicator()
    const bibleVersion = getBibleVersion(this.settings.bibleVersion)
    this.statusBarIndicator = this.addStatusBarItem()
    // todo add an icon
    this.statusBarIndicator.createEl('span', {
      text: `${bibleVersion.versionName}(${bibleVersion.language})`,
      cls: 'bible-version-indicator',
    })
    // create event listener for the update
    pluginEvent.on('bible-reference:settings:version', () => {
      this.updateStatusBarIndicator()
    })
    // this.registerEvent(versionChangeEventRef) // somehow this is not necessary
  }

  private removeStatusBarIndicator(): void {
    if (this.statusBarIndicator) {
      this.statusBarIndicator.parentNode?.removeChild(this.statusBarIndicator)
    }
  }

  private updateStatusBarIndicator(): void {
    const bibleVersion = getBibleVersion(this.settings.bibleVersion)
    if (
      this.statusBarIndicator &&
      'getElementsByClassName' in this.statusBarIndicator
    ) {
      const el = this.statusBarIndicator.getElementsByClassName(
        'bible-version-indicator'
      )[0]
      el.innerHTML = `${bibleVersion.versionName}(${bibleVersion.language})`
    }
  }
}
