// CryptoKit verification for the selected RFC 9180 vector.
import CryptoKit
import Foundation

struct Enc: Decodable { let ct: String; let aad: String; let pt: String }
struct Vec: Decodable { let skRm: String; let enc: String; let info: String; let encryptions: [Enc] }

func bytes(_ hex: String) -> Data {
  var data = Data(); var index = hex.startIndex
  while index < hex.endIndex {
    let next = hex.index(index, offsetBy: 2)
    data.append(UInt8(hex[index..<next], radix: 16)!)
    index = next
  }
  return data
}

let vec = try JSONDecoder().decode(Vec.self, from: try Data(contentsOf: URL(fileURLWithPath: "vector-for-swift.json")))
let sk = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: bytes(vec.skRm))
let suite = HPKE.Ciphersuite(kem: .Curve25519_HKDF_SHA256, kdf: .HKDF_SHA256, aead: .AES_GCM_256)
var recipient = try HPKE.Recipient(privateKey: sk, ciphersuite: suite, info: bytes(vec.info), encapsulatedKey: bytes(vec.enc))
var opened = 0
for enc in vec.encryptions {
  let pt = try recipient.open(bytes(enc.ct), authenticating: bytes(enc.aad))
  guard pt == bytes(enc.pt) else { fatalError("plaintext mismatch at index \(opened)") }
  opened += 1
}
print("{\"swiftEncryptionsOpened\": \(opened), \"ok\": true}")
