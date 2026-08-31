// RFC 8785 canonicalization fixture for the protocol value domain.
import Foundation

struct JcsVector: Decodable { let inputJson: String; let canonicalHex: String }
struct Fx: Decodable { let jcsVectors: [JcsVector]; let transcriptBytesHex: String; let grantBytesHex: String }

func hex(_ s: String) -> Data {
  var d = Data(); var i = s.startIndex
  while i < s.endIndex { let n = s.index(i, offsetBy: 2); d.append(UInt8(s[i..<n], radix: 16)!); i = n }
  return d
}

enum JcsError: Error { case unsupported(String) }

func escape(_ s: String) -> String {
  var out = "\""
  for scalar in s.unicodeScalars {
    switch scalar {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\u{08}": out += "\\b"
    case "\u{0C}": out += "\\f"
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    default:
      if scalar.value < 0x20 {
        out += String(format: "\\u%04x", scalar.value)
      } else {
        out.unicodeScalars.append(scalar)
      }
    }
  }
  return out + "\""
}

func canonical(_ value: Any) throws -> String {
  if value is NSNull { return "null" }
  if let n = value as? NSNumber {
    if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
    let i = n.int64Value
    guard NSNumber(value: i) == n, abs(i) <= 9007199254740991 else { throw JcsError.unsupported("non-integer number") }
    return String(i)
  }
  if let s = value as? String { return escape(s) }
  if let a = value as? [Any] { return "[" + (try a.map(canonical)).joined(separator: ",") + "]" }
  if let o = value as? [String: Any] {
    let keys = o.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
    return "{" + (try keys.map { escape($0) + ":" + (try canonical(o[$0]!)) }).joined(separator: ",") + "}"
  }
  throw JcsError.unsupported("\(type(of: value))")
}

func canonicalBytes(ofJson data: Data) throws -> Data {
  let obj = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
  return Data(try canonical(obj).utf8)
}

let fx = try JSONDecoder().decode(Fx.self, from: try Data(contentsOf: URL(fileURLWithPath: "../fixtures.json")))
var vectorsOk = 0
for v in fx.jcsVectors where try canonicalBytes(ofJson: Data(v.inputJson.utf8)) == hex(v.canonicalHex) { vectorsOk += 1 }
let transcriptOk = try canonicalBytes(ofJson: hex(fx.transcriptBytesHex)) == hex(fx.transcriptBytesHex)
let grantOk = try canonicalBytes(ofJson: hex(fx.grantBytesHex)) == hex(fx.grantBytesHex)
// Reordered input must produce the same bytes.
let parsed = try JSONSerialization.jsonObject(with: hex(fx.transcriptBytesHex)) as! [String: Any]
var shuffled: [String: Any] = [:]
for (k, v) in parsed.sorted(by: { $0.key > $1.key }) { shuffled[k] = v }
let reorderedOk = Data(try canonical(shuffled).utf8) == hex(fx.transcriptBytesHex)
print("{\"jcsVectorsOk\": \(vectorsOk), \"jcsVectorsTotal\": \(fx.jcsVectors.count), \"transcriptBytesIdentical\": \(transcriptOk), \"grantBytesIdentical\": \(grantOk), \"reorderedIdentical\": \(reorderedOk)}")
