/* eslint-disable no-console */
import process from 'node:process'
import { basename, join, relative } from 'node:path'
import prompts from 'prompts'
import c from 'chalk'
import fg from 'fast-glob'
import boxen from 'boxen'
import fs from 'fs-extra'
import pLimit from 'p-limit'
import { version } from '../package.json'
import type { PreprocessOptions } from './scan'
import { verifyScan } from './scan'

export interface CliOptions {
  dirSource: string
  dirValid: string
  dirInvalid: string
  mode: 'move' | 'copy' | 'none' | 'move-valid' | 'move-invalid'
  tolerance: 'none' | 'high' | 'medium'
}

async function run() {
  const options: CliOptions = {
    dirSource: process.cwd(),
    dirValid: join(process.cwd(), 'scannable'),
    dirInvalid: join(process.cwd(), 'non-scannable'),
    mode: 'move',
    tolerance: 'high',
  }

  const relativePath = (p: string) => {
    const a = relative(options.dirSource, p)
    if (a.startsWith('..'))
      return p
    return `./${a}`
  }

  const files = await fg('*.{png,jpg,jpeg,webp}', {
    cwd: options.dirSource,
    onlyFiles: true,
    dot: false,
    absolute: true,
  })

  console.log(`\n${c.green.bold.inverse(' QR Code Verifier ') + c.gray(` v${version}`)}\n`)

  if (!files.length) {
    console.log(c.yellow('No images found in this directory\n'))
    process.exit(0)
  }
  else {
    console.log(`${c.blue.bold(files.length)} images founded\n`)
  }

  Object.assign(options, await prompts([
    {
      type: 'select',
      name: 'mode',
      message: 'Select the mode of file operation',
      choices: [
        {
          value: 'move',
          title: 'Move images',
        },
        {
          value: 'copy',
          title: 'Copy images',
        },
        {
          value: 'none',
          title: 'Scan only',
        },
        {
          value: 'move-valid',
          title: 'Move scannable images only',
        },
        {
          value: 'move-invalid',
          title: 'Move non-scannable images only',
        },
      ],
    },
    {
      type: 'select',
      name: 'tolerance',
      message: 'Select scanner tolerance (chance to get scanned)',
      choices: [
        {
          value: 'high',
          title: 'High tolerance (try 25 times)',
        },
        {
          value: 'medium',
          title: 'Medium tolerance (try 9 times)',
        },
        {
          value: 'none',
          title: 'No preprocessing',
        },
      ],
    },
  ]))

  const lines = [
    'Verify scannable QR Code in the current directory:',
    c.blue(`${options.dirSource}`),
    '',
  ]

  if (options.mode === 'none') {
    lines.push(
      'Prints the scan result only.',
    )
  }
  else if (options.mode === 'move-invalid') {
    lines.push(
      'If it\'s scannable, print the result only.',
      `If not, ${c.yellow.bold('move')} to:`,
      c.blue(`${relativePath(options.dirInvalid)}`),
    )
  }
  else if (options.mode === 'move-valid') {
    lines.push(
      `If it's scannable, ${c.yellow.bold('move')} to:`,
      c.blue(`${relativePath(options.dirValid)}`),
      'If not, print the result only.',
    )
  }
  else {
    const mode = options.mode === 'copy'
      ? c.green.bold(options.mode)
      : c.yellow.bold(options.mode)
    lines.push(
      `If it's scannable, ${mode} to:`,
      c.blue(`${relativePath(options.dirValid)}`),
      `If not, ${mode} to:`,
      c.blue(`${relativePath(options.dirInvalid)}`),
    )
  }

  console.log()
  console.log(boxen(lines.join('\n'), { padding: 1, borderColor: 'green', borderStyle: 'round' }))
  console.log()

  const { confirm } = await prompts([
    {
      name: 'confirm',
      type: 'confirm',
      initial: true,
      message: 'Start?',
    },
  ])

  if (!confirm)
    process.exit(1)

  console.log()

  const limit = pLimit(5)

  await Promise.all([
    fs.ensureDir(options.dirValid),
    fs.ensureDir(options.dirInvalid),
  ])

  let validCount = 0
  let invalidCount = 0

  const preprocess = options.tolerance === 'high'
    ? createPreprocessCombinations(
      [4, 3, 1.5],
      [0.9, 1.1, 1.2, 1.4],
      [0.5, 1, 2],
    )
    : options.tolerance === 'medium'
      ? createPreprocessCombinations(
        [1.5],
        [0.9, 1.1],
        [0.5, 1],
      )
      : []

  await Promise.all(
    files.map(file => limit(async () => {
      const result = await verifyScan(file, {
        resize: 300,
        preprocess: [
          {},
          ...preprocess,
        ].sort(() => Math.random() - 0.5),
      })

      const path = relative(options.dirSource, file)

      if (result) {
        validCount += 1
        console.log(`${c.green.bold.inverse(' SCAN ')} ${c.gray(`${path} - `)}${c.green.bold(result)}`)
      }
      else {
        invalidCount += 1
        console.log(`${c.red.bold.inverse(' FAIL ')} ${c.gray(path)}`)
      }

      if (options.mode !== 'none') {
        const targetDir = result ? options.dirValid : options.dirInvalid
        if (options.mode === 'copy')
          await fs.copy(file, join(targetDir, basename(file)))
        else if (options.mode === 'move')
          await fs.move(file, join(targetDir, basename(file)))
        else if (options.mode === 'move-valid' && result)
          await fs.move(file, join(targetDir, basename(file)))
        else if (options.mode === 'move-invalid' && !result)
          await fs.move(file, join(targetDir, basename(file)))
      }
    })),
  )

  console.log(`\n${c.green.bold('Task finished.')}\n${c.green.bold(validCount)} scannable images, ${c.yellow.bold(invalidCount)} non-scannable images.`)
  console.log(`\n${c.gray('Note that non-scannable images do no mean they are impossible to scan,\nbut at least it indicates they may be hard to scan.\nYou can utilize https://qrcode.antfu.me to investigate more.')}\n`)
}

function createPreprocessCombinations(
  _contrast: number[],
  _brightness: number[],
  _blur: number[],
): PreprocessOptions[] {
  return _contrast.flatMap(contrast =>
    _blur.flatMap(blur =>
      _brightness.map((brightness) => {
        return {
          contrast,
          blur,
          brightness,
        }
      }),
    ),
  )
}

run()
