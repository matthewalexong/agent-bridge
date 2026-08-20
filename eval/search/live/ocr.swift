#!/usr/bin/env swift
// OCR an image via macOS Vision framework — deterministic, local, free.
import Vision
import AppKit
import Foundation

let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let cgImage = bitmap.cgImage else {
    fputs("cannot load image\n", stderr); exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])

for obs in (request.results ?? []) {
    if let top = obs.topCandidates(1).first {
        print(top.string)
    }
}
