import assert from "node:assert/strict";
import {describe, it} from "node:test";

import type {z} from "zod";

import {
  addressInputSchema,
  additionalInfoInputSchema,
  businessInputSchema,
  profileSchema,
  registrationInputSchema,
} from "./profileSchema.js";

type ProfileInput = z.infer<typeof profileSchema>;

const VALID_JAPAN_ADDRESS = {
  country: "JP",
  postalCode: "123-4567",
  prefecture: "東京都",
  city: "千代田区",
  addressLine: "1-1-1",
  building: null,
} as const;

const VALID_INTERNATIONAL_ADDRESS = {
  country: "US",
  postalCode: "94105",
  state: "CA",
  city: "San Francisco",
  addressLine1: "1 Market St",
  addressLine2: null,
} as const;

const VALID_BUSINESS = {
  companyName: "Integration Inc.",
  department: null,
  contactPerson: "Taro Yamada",
} as const;

/**
 * Builds a valid base profile, overridable per test case.
 *
 * @param {Partial<ProfileInput>} overrides Fields to override.
 * @return {ProfileInput} Valid profile input fixture.
 */
function validProfile(overrides: Partial<ProfileInput> = {}): ProfileInput {
  return {
    name: "山田太郎",
    nameKana: "ヤマダタロウ",
    phoneNumber: "090-1234-5678",
    dateOfBirth: "1990-01-01",
    gender: "no_answer",
    newsletterOptIn: false,
    accountType: "individual",
    business: null,
    address: VALID_JAPAN_ADDRESS,
    ...overrides,
  };
}

describe("addressInputSchema", () => {
  it("accepts a valid Japan address", () => {
    const result = addressInputSchema.safeParse(VALID_JAPAN_ADDRESS);
    assert.equal(result.success, true);
  });

  it("accepts a valid international address", () => {
    const result = addressInputSchema.safeParse(VALID_INTERNATIONAL_ADDRESS);
    assert.equal(result.success, true);
  });

  it("rejects an unsupported country code", () => {
    const result = addressInputSchema.safeParse({
      ...VALID_INTERNATIONAL_ADDRESS,
      country: "XX",
    });
    assert.equal(result.success, false);
  });

  it("rejects a Japan address missing required fields", () => {
    const result = addressInputSchema.safeParse({
      country: "JP",
      postalCode: "123-4567",
    });
    assert.equal(result.success, false);
  });

  it("rejects an international address using Japan-only fields", () => {
    const result = addressInputSchema.safeParse({
      country: "US",
      postalCode: "94105",
      prefecture: "東京都",
      city: "San Francisco",
      addressLine: "1 Market St",
      building: null,
    });
    assert.equal(result.success, false);
  });
});

describe("businessInputSchema", () => {
  it("accepts a valid business fixture", () => {
    assert.equal(businessInputSchema.safeParse(VALID_BUSINESS).success, true);
  });

  it("rejects a missing contactPerson", () => {
    const result = businessInputSchema.safeParse({
      ...VALID_BUSINESS,
      contactPerson: "",
    });
    assert.equal(result.success, false);
  });

  it("rejects a missing companyName", () => {
    const result = businessInputSchema.safeParse({
      ...VALID_BUSINESS,
      companyName: "",
    });
    assert.equal(result.success, false);
  });
});

describe("profileSchema: nameKana", () => {
  it("accepts a valid katakana nameKana", () => {
    const result = profileSchema.safeParse(validProfile({
      nameKana: "ヤマダ・タロウ",
    }));
    assert.equal(result.success, true);
  });

  // Members without a kanji/kana name must be able to register at all.
  it("accepts a romaji nameKana", () => {
    const result = profileSchema.safeParse(validProfile({
      nameKana: "John Smith",
    }));
    assert.equal(result.success, true);
  });

  it("accepts accented and Vietnamese Latin forms", () => {
    for (const nameKana of ["José Álvarez", "Müller", "Nguyễn Văn A"]) {
      const result = profileSchema.safeParse(validProfile({nameKana}));
      assert.equal(result.success, true, nameKana);
    }
  });

  it("accepts Latin name punctuation", () => {
    for (const nameKana of ["O'Brien", "Jean-Luc Picard", "J. R. Tolkien"]) {
      const result = profileSchema.safeParse(validProfile({nameKana}));
      assert.equal(result.success, true, nameKana);
    }
  });

  it("rejects a hiragana nameKana", () => {
    const result = profileSchema.safeParse(validProfile({
      nameKana: "やまだたろう",
    }));
    assert.equal(result.success, false);
  });

  it("rejects a kanji nameKana", () => {
    const result = profileSchema.safeParse(validProfile({
      nameKana: "山田 太郎",
    }));
    assert.equal(result.success, false);
  });

  it("rejects a separator-only nameKana", () => {
    for (const nameKana of ["・・", " - "]) {
      const result = profileSchema.safeParse(validProfile({nameKana}));
      assert.equal(result.success, false, nameKana);
    }
  });
});

describe("profileSchema: dateOfBirth", () => {
  it("accepts a valid past calendar date", () => {
    const result = profileSchema.safeParse(validProfile({
      dateOfBirth: "1990-01-01",
    }));
    assert.equal(result.success, true);
  });

  it("rejects an invalid calendar date", () => {
    const result = profileSchema.safeParse(validProfile({
      dateOfBirth: "1990-02-30",
    }));
    assert.equal(result.success, false);
  });

  it("rejects a future date", () => {
    const futureYear = new Date().getUTCFullYear() + 1;
    const result = profileSchema.safeParse(validProfile({
      dateOfBirth: `${futureYear}-01-01`,
    }));
    assert.equal(result.success, false);
  });

  it("rejects a malformed date string", () => {
    const result = profileSchema.safeParse(validProfile({
      dateOfBirth: "1990/01/01",
    }));
    assert.equal(result.success, false);
  });
});

describe("profileSchema: accountType/business conditional", () => {
  it("accepts an individual account with a null business", () => {
    const result = profileSchema.safeParse(validProfile({
      accountType: "individual",
      business: null,
    }));
    assert.equal(result.success, true);
  });

  it("rejects an individual account with a non-null business " +
    "(the impossible direction)", () => {
    const result = profileSchema.safeParse(validProfile({
      accountType: "individual",
      business: VALID_BUSINESS,
    }));
    assert.equal(result.success, false);
  });

  it("accepts a corporate account with a valid business", () => {
    const result = profileSchema.safeParse(validProfile({
      accountType: "corporate",
      business: VALID_BUSINESS,
    }));
    assert.equal(result.success, true);
  });

  it("rejects a corporate account with a null business", () => {
    const result = profileSchema.safeParse(validProfile({
      accountType: "corporate",
      business: null,
    }));
    assert.equal(result.success, false);
  });

  it("rejects corporate missing contactPerson", () => {
    const result = profileSchema.safeParse(validProfile({
      accountType: "corporate",
      business: {...VALID_BUSINESS, contactPerson: ""},
    }));
    assert.equal(result.success, false);
  });

  it("accepts a sole-proprietor account with a valid business", () => {
    const result = profileSchema.safeParse(validProfile({
      accountType: "sole-proprietor",
      business: VALID_BUSINESS,
    }));
    assert.equal(result.success, true);
  });

  it("rejects sole-proprietor missing contactPerson, identically to " +
    "corporate", () => {
    const soleProprietorResult = profileSchema.safeParse(validProfile({
      accountType: "sole-proprietor",
      business: {...VALID_BUSINESS, contactPerson: ""},
    }));
    const corporateResult = profileSchema.safeParse(validProfile({
      accountType: "corporate",
      business: {...VALID_BUSINESS, contactPerson: ""},
    }));
    assert.equal(soleProprietorResult.success, false);
    assert.equal(corporateResult.success, false);
  });

  it("rejects sole-proprietor with a null business", () => {
    const result = profileSchema.safeParse(validProfile({
      accountType: "sole-proprietor",
      business: null,
    }));
    assert.equal(result.success, false);
  });
});

describe("registrationInputSchema", () => {
  it("accepts email/password combined with a valid profile", () => {
    const result = registrationInputSchema.safeParse({
      email: "member@example.com",
      password: "Password123!",
      ...validProfile(),
    });
    assert.equal(result.success, true);
  });

  it("rejects a missing password", () => {
    const result = registrationInputSchema.safeParse({
      email: "member@example.com",
      ...validProfile(),
    });
    assert.equal(result.success, false);
  });

  it("rejects an invalid nested profile even with valid email/password",
    () => {
      const result = registrationInputSchema.safeParse({
        email: "member@example.com",
        password: "Password123!",
        ...validProfile({accountType: "corporate", business: null}),
      });
      assert.equal(result.success, false);
    });
});

describe("additionalInfoInputSchema", () => {
  it("accepts a valid profile without email/password", () => {
    const result = additionalInfoInputSchema.safeParse(validProfile());
    assert.equal(result.success, true);
  });

  it("rejects an individual profile carrying a business object", () => {
    const result = additionalInfoInputSchema.safeParse(validProfile({
      accountType: "individual",
      business: VALID_BUSINESS,
    }));
    assert.equal(result.success, false);
  });
});
